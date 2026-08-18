'use strict';

/**
 * A small App Store Connect API client, with no dependencies.
 *
 * Why this instead of fastlane, which is the usual answer: `deliver` handles metadata and
 * screenshots well, but it cannot set a per-territory subscription price, and per-territory
 * subscription prices are half of what this repo needs. Running two tools against the same
 * credential to cover one job is worse than running one. On top of that, current fastlane
 * needs a Ruby newer than the 2.6 macOS ships, so it is not a zero-install option either,
 * while Node is already here for every other script in this folder.
 *
 * Credentials come from the environment and never from a tracked file:
 *
 *   ASC_KEY_ID           the ten character key id, shown next to the key in ASC
 *   ASC_ISSUER_ID        the uuid at the top of Users and Access > Integrations
 *   ASC_PRIVATE_KEY      the .p8 contents, or
 *   ASC_PRIVATE_KEY_PATH a path to the .p8 file
 *
 * The key is an account-wide credential: anyone holding it can edit metadata, prices and
 * agreements for every app on the team. It is not an app secret and it is not a build
 * secret, so it never belongs in the repo, in app.json, or in anything the bundler reads.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');

const { loadDotEnv, expandHome } = require('../lib/root');

const { RETRIES, backoff } = require('../lib/retry');

const BASE = 'https://api.appstoreconnect.apple.com';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function readPrivateKey() {
  const inline = process.env.ASC_PRIVATE_KEY;
  if (inline && inline.includes('BEGIN PRIVATE KEY')) {
    // Shell exports collapse newlines into the two character sequence \n often enough that
    // handling it here is cheaper than explaining the failure in a support message.
    return inline.replace(/\\n/g, '\n');
  }

  const keyPath = process.env.ASC_PRIVATE_KEY_PATH;
  if (!keyPath) {
    throw new Error(
      'Set ASC_PRIVATE_KEY_PATH to the .p8 file you downloaded from App Store Connect ' +
        '(or ASC_PRIVATE_KEY to its contents). See store/ASC-API-SETUP.md.',
    );
  }
  const resolved = expandHome(keyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`ASC_PRIVATE_KEY_PATH points at ${resolved}, which does not exist.`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/**
 * Signs a fresh ES256 token.
 *
 * Two details are easy to get wrong and both fail as a flat 401 with no explanation. The
 * signature has to be the raw r||s pair rather than the DER structure Node produces by
 * default, which is what `dsaEncoding: 'ieee-p1363'` selects. And the lifetime cannot
 * exceed twenty minutes; Apple rejects a longer one outright rather than clamping it.
 */
function mintToken() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  if (!keyId) throw new Error('ASC_KEY_ID is not set. See store/ASC-API-SETUP.md.');
  if (!issuerId) throw new Error('ASC_ISSUER_ID is not set. See store/ASC-API-SETUP.md.');

  const privateKey = crypto.createPrivateKey(readPrivateKey());
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + 15 * 60,
      aud: 'appstoreconnect-v1',
    }),
  );

  const signature = crypto
    .sign('sha256', Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');

  return { token: `${header}.${payload}.${signature}`, expiresAt: (issuedAt + 15 * 60) * 1000 };
}

class AppStoreConnect {
  /**
   * @param {{ dryRun?: boolean, verbose?: boolean }} [options]
   */
  constructor(options = {}) {
    loadDotEnv();
    this.dryRun = options.dryRun ?? false;
    this.verbose = options.verbose ?? false;
    this.cached = null;
    this.writes = [];
  }

  token() {
    // Re-minted a minute before expiry so a long pricing run never dies halfway through
    // with a 401 that looks like a credential problem rather than a clock problem.
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) return this.cached.token;
    this.cached = mintToken();
    return this.cached.token;
  }

  async request(method, endpoint, body, attempt = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`;

    if (this.dryRun && method !== 'GET') {
      this.writes.push({ method, url, body });
      if (this.verbose) console.log(`  [dry-run] ${method} ${url.replace(BASE, '')}`);
      return { data: { id: `dry-run-${this.writes.length}`, attributes: {} } };
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // 429 is the only status worth retrying blind. Apple allows 3600 requests an hour and a
    // full push sits well under that, but a run that follows a failed run inside the same
    // window can still trip it, and losing an hour of work to that would be absurd.
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? 10);
      if (this.verbose) console.log(`  rate limited, waiting ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return this.request(method, endpoint, body);
    }

    // A 401 arriving mid-run is not the credential problem its message describes. The token
    // is re-minted a minute before expiry and the run that first hit this had been going for
    // seventy seven seconds against a fifteen minute lifetime, so an expired token cannot
    // explain it. Apple simply rejects the odd request during a burst, and a hundred and
    // thirty eight screenshot uploads is a burst. Re-minting costs nothing and rules out the
    // one cause we could actually be wrong about, so the cached token is dropped first.
    //
    // Retried for writes too, unlike the 500 below, and the difference is real rather than
    // convenient: a request refused at authentication never reached the resource, so there
    // is nothing half-applied for a repeat to duplicate.
    if (response.status === 401 && attempt < 2) {
      this.cached = null;
      const wait = 2 ** attempt;
      if (this.verbose) console.log(`  401 from Apple, re-minting and retrying in ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return this.request(method, endpoint, body, attempt + 1);
    }

    // Apple returns a bare 500 now and then, and it clears on a retry seconds later. A
    // pricing run is a hundred and thirty writes over several minutes, so treating one of
    // those as fatal means losing the whole run to a hiccup and restarting it by hand.
    //
    // Retried only for GET. A POST that got a 500 may or may not have been applied, and
    // repeating it blind could create a second copy of something; that case is worth
    // stopping for. Reads have no such risk.
    //
    // Five attempts rather than three, and the wait is jittered. Reading every price point
    // for one subscription is a walk of dozens of pages, so a run makes hundreds of GETs and
    // the chance of meeting at least one 500 is not small: three attempts over seven seconds
    // was observed losing a whole pricing run twice in a row while the same command
    // succeeded on either side of it. The jitter matters because the pages are walked in a
    // tight loop, and a fixed backoff marches every retry into the same busy moment.
    if (response.status >= 500 && method === 'GET' && attempt < RETRIES) {
      const wait = backoff(attempt);
      if (this.verbose) {
        console.log(`  ${response.status} from Apple, retrying in ${wait.toFixed(1)}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return this.request(method, endpoint, body, attempt + 1);
    }

    if (response.status === 204) return null;

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new AscError(method, url, response.status, parsed);
    }

    return parsed;
  }

  get(endpoint) {
    return this.request('GET', endpoint);
  }

  post(endpoint, body) {
    return this.request('POST', endpoint, body);
  }

  patch(endpoint, body) {
    return this.request('PATCH', endpoint, body);
  }

  delete(endpoint) {
    return this.request('DELETE', endpoint);
  }

  /**
   * Follows `links.next` until the collection runs out.
   *
   * The default page size is 20 and several things this repo reads are longer than that:
   * there are 175 territories, and a subscription carries hundreds of price points per
   * territory. A single unpaginated GET would quietly return the first twenty and every
   * downstream lookup would then fail to find a perfectly valid entry.
   */
  async list(endpoint) {
    return (await this.listFull(endpoint)).data;
  }

  /**
   * Like `list`, but keeps the `included` side-loaded objects too.
   *
   * `list` throws them away, which is right for the common case and wrong for reading a
   * price back. A price object holds only a link to its price point, so the actual amount
   * lives in `included`. Dropping it and then re-fetching the price points separately to
   * match ids by hand is how a verification pass ends up comparing against the wrong page
   * and reporting numbers that were never set.
   */
  async listFull(endpoint) {
    const data = [];
    const included = [];
    let next = endpoint.includes('limit=')
      ? endpoint
      : `${endpoint}${endpoint.includes('?') ? '&' : '?'}limit=200`;

    while (next) {
      const page = await this.get(next);
      data.push(...(page.data ?? []));
      included.push(...(page.included ?? []));
      next = page.links?.next ?? null;
    }

    return { data, included };
  }
}

/**
 * Apple's errors carry the useful part in `errors[].detail`, and for an invalid enum they
 * list every accepted value there. Surfacing that verbatim turns "422 Unprocessable" into
 * an answer, which matters because the accepted locale codes are not documented anywhere
 * that renders without JavaScript.
 */
class AscError extends Error {
  constructor(method, url, status, payload) {
    const details = (payload?.errors ?? [])
      .map((error) => {
        const where = error.source?.pointer ?? error.source?.parameter ?? '';
        return `    ${error.title}: ${error.detail}${where ? ` (${where})` : ''}`;
      })
      .join('\n');

    super(`${method} ${url.replace(BASE, '')} failed with ${status}\n${details}`);
    this.name = 'AscError';
    this.status = status;
    this.errors = payload?.errors ?? [];
  }
}

module.exports = { AppStoreConnect, AscError, BASE, mintToken };
