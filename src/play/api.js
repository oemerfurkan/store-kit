'use strict';

/**
 * A small Google Play Developer API client, with no dependencies.
 *
 * The mirror of `scripts/asc/api.js`, and deliberately the same shape: same dry-run flag,
 * same verbose flag, same pagination helper, same "errors carry the useful part" philosophy.
 * Anyone who has read one should be able to read the other without relearning anything.
 *
 * Auth is where the two genuinely differ. App Store Connect takes a signed ES256 JWT
 * directly as the bearer token. Google will not: it takes an RS256 JWT and makes you
 * exchange it for a short-lived access token first, so there is a network round trip before
 * any real request. Two consequences follow, and both are handled below. The signature needs
 * no `dsaEncoding` flag, because that flag exists for ECDSA and this is RSA; passing one
 * here out of habit produces a signature Google rejects with a flat 400. And the token has
 * to be cached, or every call pays for an extra request.
 *
 * Credentials come from the environment and never from a tracked file:
 *
 *   PLAY_SERVICE_ACCOUNT_KEY_PATH  path to the service account JSON from Google Cloud
 *   PLAY_SERVICE_ACCOUNT_KEY       the same JSON inline, for CI
 *
 * The key is account-wide: whoever holds it can edit listings, prices and releases for every
 * app the service account is granted on. It belongs outside the repo, and `.gitignore` and
 * `.easignore` both exclude `.env` so the path can live there safely while the file itself
 * does not.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');

const { loadDotEnv, expandHome } = require('../lib/root');
const { load, requireAndroid } = require('../lib/config');

const { RETRIES, backoff } = require('../lib/retry');

const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * The package this app publishes.
 *
 * Read from app.json when there is one, so it cannot drift from the build, and from
 * `shared.androidPackage` otherwise. `requireAndroid` owns that precedence; this wrapper
 * exists only because callers have always spelled it `packageName()`.
 */
function packageName() {
  return requireAndroid(load());
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function readServiceAccount() {
  const inline = process.env.PLAY_SERVICE_ACCOUNT_KEY;
  if (inline && inline.trim().startsWith('{')) return JSON.parse(inline);

  const keyPath = process.env.PLAY_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    throw new Error(
      'Set PLAY_SERVICE_ACCOUNT_KEY_PATH to the service account JSON downloaded from Google ' +
        'Cloud (or PLAY_SERVICE_ACCOUNT_KEY to its contents).',
    );
  }
  const resolved = expandHome(keyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PLAY_SERVICE_ACCOUNT_KEY_PATH points at ${resolved}, which does not exist.`);
  }
  const key = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!key.client_email || !key.private_key) {
    throw new Error(
      `${resolved} is not a service account key: it has no client_email or private_key. ` +
        'Download the JSON key rather than the OAuth client secret.',
    );
  }
  return key;
}

class PlayApi {
  /**
   * @param {{ dryRun?: boolean, verbose?: boolean }} [options]
   */
  constructor(options = {}) {
    loadDotEnv();
    this.dryRun = options.dryRun ?? false;
    this.verbose = options.verbose ?? false;
    this.key = readServiceAccount();
    this.package = packageName();
    this.cached = null;
    this.writes = [];
  }

  get serviceAccountEmail() {
    return this.key.client_email;
  }

  /**
   * Exchanges a signed assertion for an access token, once an hour.
   *
   * Re-fetched a minute before expiry for the same reason the ASC client re-mints early: a
   * pricing run is minutes long and a token that dies halfway through surfaces as a 401 that
   * reads like a permissions problem rather than a clock one.
   */
  async token() {
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) return this.cached.token;

    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: this.key.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const signature = crypto
      .sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), this.key.private_key)
      .toString('base64url');

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${payload}.${signature}`,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        `Token exchange failed with ${response.status}: ${body.error_description ?? body.error}. ` +
          'A clock more than five minutes out of step is the usual cause of invalid_grant.',
      );
    }

    this.cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.cached.token;
  }

  async request(method, endpoint, { body, contentType, raw } = {}, attempt = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`;

    if (this.dryRun && method !== 'GET') {
      this.writes.push({ method, url, body });
      if (this.verbose) console.log(`  [dry-run] ${method} ${url.replace(BASE, '')}`);
      return { id: `dry-run-${this.writes.length}` };
    }

    const headers = { authorization: `Bearer ${await this.token()}` };
    if (contentType) headers['content-type'] = contentType;
    else if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      ...(raw !== undefined ? { body: raw } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? 10);
      if (this.verbose) console.log(`  rate limited, waiting ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return this.request(method, endpoint, { body, contentType, raw });
    }

    // Same rule as the ASC client, and for the same reason: reads are safe to repeat and
    // writes are not. A POST that got a 500 may already have been applied, and a blind retry
    // could leave two of whatever it created.
    //
    // Same budget too, from the same shared helper, so the two clients cannot drift into
    // disagreeing about how patient a read should be.
    if (response.status >= 500 && method === 'GET' && attempt < RETRIES) {
      const wait = backoff(attempt);
      if (this.verbose) {
        console.log(`  ${response.status} from Google, retrying in ${wait.toFixed(1)}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return this.request(method, endpoint, { body, contentType, raw }, attempt + 1);
    }

    // 204 on a collection means "authorised, and empty", which is a real answer rather than
    // an error: an app with no subscriptions yet returns it from subscriptions.list.
    if (response.status === 204) return null;

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!response.ok) throw new PlayError(method, url, response.status, parsed);
    return parsed;
  }

  get(endpoint) {
    return this.request('GET', endpoint);
  }

  post(endpoint, body) {
    return this.request('POST', endpoint, { body });
  }

  put(endpoint, body) {
    return this.request('PUT', endpoint, { body });
  }

  patch(endpoint, body) {
    return this.request('PATCH', endpoint, { body });
  }

  delete(endpoint) {
    return this.request('DELETE', endpoint);
  }

  /** Uploads bytes. Play takes images as a bare body with a media path, not multipart. */
  upload(endpoint, bytes, contentType) {
    return this.request('POST', endpoint, { raw: bytes, contentType });
  }

  /**
   * Follows `nextPageToken` until the collection runs out.
   *
   * Google paginates with a token in the body rather than a link, so this cannot reuse the
   * ASC helper. `key` names the array to accumulate, because unlike ASC there is no single
   * `data` field: subscriptions come back under `subscriptions`, products under
   * `inappproduct`, and so on.
   */
  async list(endpoint, key) {
    const items = [];
    let token = null;
    do {
      const joiner = endpoint.includes('?') ? '&' : '?';
      const page = await this.get(token ? `${endpoint}${joiner}token=${token}` : endpoint);
      if (!page) break;
      items.push(...(page[key] ?? []));
      token = page.tokenPagination?.nextPageToken ?? null;
    } while (token);
    return items;
  }
}

/**
 * Google puts the useful part in `error.message`, and for a permission problem it names the
 * exact scope or grant that is missing. Surfacing it verbatim is the difference between
 * "403 Forbidden" and "the service account has no access to financial data".
 */
class PlayError extends Error {
  constructor(method, url, status, payload) {
    const error = payload?.error ?? {};
    const details = (error.details ?? [])
      .map((detail) => `    ${detail['@type'] ?? 'detail'}: ${JSON.stringify(detail)}`)
      .join('\n');

    super(
      `${method} ${url.replace(BASE, '')} failed with ${status}\n    ${error.message ?? ''}` +
        (details ? `\n${details}` : ''),
    );
    this.name = 'PlayError';
    this.status = status;
    this.detail = error.message ?? '';
  }
}

module.exports = { PlayApi, PlayError, BASE, packageName };
