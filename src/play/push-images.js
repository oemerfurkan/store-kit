#!/usr/bin/env node
'use strict';

/**
 * Uploads the Play listing artwork: the store icon, the feature graphic, and the phone
 * screenshots for every locale.
 *
 *   node scripts/play/push-images.js --dry-run
 *   node scripts/play/push-images.js
 *   node scripts/play/push-images.js --only tr,de-DE
 *
 * The one thing to know about this endpoint, and the reason a naive version of this script
 * produces a broken listing rather than an error: **Play appends**. Posting an image adds it
 * to whatever is already there. Run the script twice and the listing has fourteen
 * screenshots; run it three times and it has twenty one, in an order nobody chose, and Play
 * accepts all of it without complaint. So every image type is deleted before it is written.
 *
 * The delete is per type per locale, which is also why this cannot share the listing script's
 * edit: images are uploaded to a different host path (`/upload/...`) and a failed upload
 * halfway through would otherwise abandon the text push as well.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PlayApi, BASE } = require('./api');
const { withEdit } = require('./edit');

const ROOT = require('../lib/root').root();
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));
const SHOTS_DIR = path.join(ROOT, 'store', 'screenshots-play');
const PLAY_ASSETS = path.join(ROOT, 'store', 'play');

const UPLOAD_BASE = BASE.replace(
  'androidpublisher.googleapis.com/androidpublisher',
  'androidpublisher.googleapis.com/upload/androidpublisher',
);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const onlyFlag = argv.indexOf('--only');
const ONLY = onlyFlag === -1 ? null : new Set(argv[onlyFlag + 1].split(','));

/** Play caps a listing at eight screenshots per type and wants at least two to publish. */
const MAX_SHOTS = 8;

/**
 * Deletes everything of one image type for one locale, then uploads the set.
 *
 * Retried as a whole rather than per file, and that pairing is the point. `api.js` refuses to
 * retry a POST on its own because a write that got a 500 may already have landed, and a blind
 * repeat could leave two of it. Here the delete is part of the unit, so a repeat starts by
 * clearing whatever the failed attempt managed to upload. Retrying a single file would be the
 * unsafe version: it is exactly how a locale ends up with seven screenshots.
 *
 * Google returns a bare 500 on this endpoint often enough that not retrying means losing a
 * hundred and forty uploads to one hiccup, which is what happened the first time this ran.
 */
async function replaceImages(api, editId, language, imageType, files, attempt = 0) {
  try {
    await api.delete(
      `/applications/${api.package}/edits/${editId}/listings/${language}/${imageType}`,
    );
    for (const file of files) {
      await api.upload(
        `${UPLOAD_BASE}/applications/${api.package}/edits/${editId}/listings/${language}/` +
          `${imageType}?uploadType=media`,
        fs.readFileSync(file),
        'image/png',
      );
    }
  } catch (error) {
    if (error.status < 500 || attempt >= 3) throw error;
    const wait = 2 ** attempt;
    console.log(`         ${language}/${imageType} got ${error.status}, redoing in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return replaceImages(api, editId, language, imageType, files, attempt + 1);
  }
}

async function main() {
  const api = new PlayApi({ dryRun: DRY_RUN, verbose: VERBOSE });
  const play = metadata.play;
  if (!play) throw new Error('store/metadata.json has no play block.');

  const icon = path.join(PLAY_ASSETS, 'icon-512.png');
  const feature = path.join(PLAY_ASSETS, 'feature-graphic.png');
  for (const file of [icon, feature]) {
    if (!fs.existsSync(file)) {
      throw new Error(`${path.relative(ROOT, file)} is missing. Run npm run assets first.`);
    }
  }

  const ascLocales = Object.keys(metadata).filter(
    (key) => !key.startsWith('_') && metadata[key].name !== undefined,
  );
  const locales = ascLocales.filter((locale) => !ONLY || ONLY.has(locale));

  // Gathered before the edit opens. A locale with no composed screenshots is a missing
  // `npm run screenshots:play`, and finding that out after deleting the live images would
  // leave the listing worse than it started.
  const work = [];
  const missing = [];
  for (const locale of locales) {
    const playLocale = play.locales[locale];
    const dir = path.join(SHOTS_DIR, playLocale);
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((file) => file.endsWith('.png'))
          .sort()
          .slice(0, MAX_SHOTS)
          .map((file) => path.join(dir, file))
      : [];
    if (files.length < 2) {
      missing.push(`${locale} -> ${playLocale} (${files.length} screenshot(s), Play wants 2+)`);
      continue;
    }
    work.push({ locale, playLocale, files });
  }

  if (missing.length > 0) {
    console.error('Missing composed screenshots:\n');
    for (const line of missing) console.error(`  - ${line}`);
    console.error('\nCompose them with: npm run screenshots:play');
    if (work.length === 0) process.exit(1);
  }

  console.log(
    `${DRY_RUN ? 'Validating' : 'Uploading'} artwork for ${work.length} localization(s).\n`,
  );

  await withEdit(
    api,
    async (editId) => {
      // Icon and feature graphic hang off the default language rather than off every locale.
      // Play allows a per-locale override and this listing has no reason to use one: the mark
      // carries no text.
      const base = play.locales[play.defaultLanguage];
      await replaceImages(api, editId, base, 'icon', [icon]);
      await replaceImages(api, editId, base, 'featureGraphic', [feature]);
      console.log(`  ${base.padEnd(8)} icon + feature graphic`);

      for (const { locale, playLocale, files } of work) {
        await replaceImages(api, editId, playLocale, 'phoneScreenshots', files);
        console.log(`  ${locale.padEnd(8)} -> ${playLocale.padEnd(7)} ${files.length} screenshots`);
      }
    },
    { label: 'images', changesNotSentForReview: true },
  );

  console.log(
    DRY_RUN
      ? '\nDry run. The edit was validated by Google and then abandoned.'
      : `\nDone. Artwork uploaded for ${work.length} localization(s).`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
