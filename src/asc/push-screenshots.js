#!/usr/bin/env node
'use strict';

/**
 * Uploads store/screenshots/<locale>/ to App Store Connect.
 *
 *   node scripts/asc/push-screenshots.js --dry-run
 *   node scripts/asc/push-screenshots.js
 *   node scripts/asc/push-screenshots.js --only tr,de-DE
 *
 * Screenshots are the one asset the API does not take in a single request. Each file goes
 * through a three step reservation:
 *
 *   1. POST /v1/appScreenshots announces the name and byte length. Apple replies with a
 *      list of upload operations, each a URL, a byte range and its own headers.
 *   2. Every operation gets a PUT of exactly its slice of the file. Usually there is one,
 *      but the protocol allows Apple to split a file across several, so the slices are
 *      taken from the response rather than assumed.
 *   3. PATCH marks it uploaded and hands over an MD5 of the whole file. Apple recomputes it
 *      and rejects the asset if they disagree, which is the only thing standing between a
 *      truncated upload and a listing full of half-drawn images.
 *
 * Existing screenshots in a set are deleted first. Without that, a second run appends and
 * the listing ends up with fourteen screens in a slot that shows ten, silently dropping
 * whichever four sort last.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { AppStoreConnect, AscError } = require('./api');
const { ROOT, metadata, resolveApp, resolveVersion } = require('./context');

const frames = require(path.join(ROOT, 'store', 'screenshot-frames.json'));
const SHOTS = path.join(ROOT, 'store', 'screenshots');

/**
 * The only iPhone slot this listing offers. A 6.9 inch asset is rejected here, which is why
 * the composer targets 1284x2778 rather than the larger size it produced first.
 */
const DISPLAY_TYPE = 'APP_IPHONE_65';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const onlyFlag = argv.indexOf('--only');
const ONLY = onlyFlag === -1 ? null : new Set(argv[onlyFlag + 1].split(','));

async function uploadOne(client, setId, file) {
  const bytes = fs.readFileSync(file);
  const fileName = path.basename(file);

  const reservation = await client.post('/v1/appScreenshots', {
    data: {
      type: 'appScreenshots',
      attributes: { fileName, fileSize: bytes.length },
      relationships: {
        appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } },
      },
    },
  });

  if (DRY_RUN) return reservation.data.id;

  for (const operation of reservation.data.attributes.uploadOperations ?? []) {
    const slice = bytes.subarray(operation.offset, operation.offset + operation.length);
    const headers = Object.fromEntries(
      (operation.requestHeaders ?? []).map((h) => [h.name, h.value]),
    );

    const response = await fetch(operation.url, {
      method: operation.method,
      headers,
      body: slice,
    });
    if (!response.ok) {
      throw new Error(
        `Uploading ${fileName} failed at offset ${operation.offset} with ${response.status}`,
      );
    }
  }

  await client.patch(`/v1/appScreenshots/${reservation.data.id}`, {
    data: {
      type: 'appScreenshots',
      id: reservation.data.id,
      attributes: {
        uploaded: true,
        sourceFileChecksum: crypto.createHash('md5').update(bytes).digest('hex'),
      },
    },
  });

  return reservation.data.id;
}

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN });

  const app = await resolveApp(client);
  const version = await resolveVersion(client, app.id);

  const localizations = new Map(
    (await client.list(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).map(
      (l) => [l.attributes.locale, l],
    ),
  );

  const locales = Object.keys(metadata)
    .filter((key) => !key.startsWith('_') && metadata[key].name !== undefined)
    .filter((locale) => !ONLY || ONLY.has(locale));

  console.log(
    `${DRY_RUN ? 'Planning' : 'Uploading'} screenshots for version ` +
      `${version.attributes.versionString}, slot ${DISPLAY_TYPE}.\n`,
  );

  const skipped = [];
  let uploaded = 0;

  for (const locale of locales) {
    const dir = path.join(SHOTS, locale);
    const expected = frames.frames.map(
      (frame, index) => path.join(dir, `${index + 1}-${frame.capture}.png`),
    );
    const present = expected.filter((file) => fs.existsSync(file));

    if (present.length === 0) {
      // Not an error. A localization with no screenshots of its own inherits the primary
      // language's, which is a working listing rather than a broken one.
      skipped.push(locale);
      continue;
    }
    if (present.length !== expected.length) {
      throw new Error(
        `${locale} has ${present.length} of ${expected.length} screenshots. Run ` +
          'npm run screenshots after capturing, rather than uploading a partial set.',
      );
    }

    const localization = localizations.get(locale);
    if (!localization) throw new Error(`${locale} has no version localization to attach to`);

    const sets = await client.list(
      `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`,
    );
    let set = sets.find((s) => s.attributes.screenshotDisplayType === DISPLAY_TYPE);

    if (!set) {
      const created = await client.post('/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: DISPLAY_TYPE },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: 'appStoreVersionLocalizations', id: localization.id },
            },
          },
        },
      });
      set = created.data;
    } else {
      const existing = await client.list(`/v1/appScreenshotSets/${set.id}/appScreenshots`);
      for (const screenshot of existing) {
        if (!DRY_RUN) await client.delete(`/v1/appScreenshots/${screenshot.id}`);
      }
    }

    const ids = [];
    for (const file of expected) {
      ids.push(await uploadOne(client, set.id, file));
    }

    // Order is a relationship, not a field on each screenshot. Without this the set keeps
    // whatever order the uploads happened to land in, and the story the set tells breaks:
    // the profile screen is a fine last frame and a baffling first one.
    if (!DRY_RUN) {
      await client.patch(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, {
        data: ids.map((id) => ({ type: 'appScreenshots', id })),
      });
    }

    uploaded += ids.length;
    console.log(`  ${locale.padEnd(8)} ${ids.length} screenshot(s)`);
  }

  if (skipped.length > 0) {
    console.log(
      `\n${skipped.length} localization(s) had no screenshots on disk and will inherit the ` +
        `primary language's: ${skipped.join(', ')}`,
    );
  }

  console.log(
    DRY_RUN
      ? '\nDry run. Nothing was uploaded. Remove --dry-run to apply.'
      : `\nDone. ${uploaded} screenshot(s) uploaded.`,
  );
}

main().catch((error) => {
  console.error(`\n${error instanceof AscError ? error.message : error.stack ?? error.message}`);
  process.exit(1);
});
