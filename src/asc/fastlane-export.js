#!/usr/bin/env node
'use strict';

/**
 * Renders store/metadata.json into the directory tree `fastlane deliver` expects.
 *
 *   node scripts/asc/fastlane-export.js
 *   cd fastlane && bundle exec fastlane deliver --skip_binary_upload
 *
 * This exists so that choosing fastlane does not mean keeping the copy twice.
 *
 * deliver reads metadata from files on disk, one file per field per language, which would
 * normally make that tree the source of truth and leave store/metadata.json as a stale
 * second copy that npm run check:store still happily validates. Generating the tree instead
 * keeps one source, keeps the length checks meaningful, and makes the fastlane path a
 * rendering target rather than a fork.
 *
 * The tree is generated, so it is gitignored. Regenerate it rather than editing it; an edit
 * made here is an edit the checker never sees and the next run overwrites.
 *
 * Two things deliver still cannot do, which is why scripts/asc/push-pricing.js and
 * push-subscriptions.js exist regardless of which tool uploads the metadata:
 *
 *  1. Per-territory subscription prices. There is no deliver action for them and no
 *     documented spaceship path either.
 *  2. Subscription group and product localizations, which live on the in-app purchase
 *     objects rather than on the app version.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ROOT, metadata } = require('./context');

const OUT = path.join(ROOT, 'fastlane', 'metadata');
const SCREENSHOT_SOURCE = path.join(ROOT, 'store', 'screenshots');
const SCREENSHOT_OUT = path.join(ROOT, 'fastlane', 'screenshots');

/**
 * The field name deliver uses for each of ours. Not a formatting nicety: deliver matches on
 * the exact filename and silently ignores anything it does not recognise, so a plausible
 * guess like `promo_text.txt` uploads nothing and reports success.
 */
const FIELD_FILES = {
  name: 'name.txt',
  subtitle: 'subtitle.txt',
  description: 'description.txt',
  keywords: 'keywords.txt',
  promotionalText: 'promotional_text.txt',
  whatsNew: 'release_notes.txt',
};

const SHARED_FILES = {
  supportUrl: 'support_url.txt',
  marketingUrl: 'marketing_url.txt',
  privacyPolicyUrl: 'privacy_url.txt',
};

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${contents}\n`);
}

function main() {
  const locales = Object.keys(metadata).filter(
    (key) => !key.startsWith('_') && metadata[key].name !== undefined,
  );

  fs.rmSync(OUT, { recursive: true, force: true });

  for (const locale of locales) {
    const block = metadata[locale];
    for (const [field, file] of Object.entries(FIELD_FILES)) {
      if (block[field] === undefined) continue;
      write(path.join(OUT, locale, file), block[field]);
    }
    for (const [field, file] of Object.entries(SHARED_FILES)) {
      write(path.join(OUT, locale, file), block[field] ?? metadata.shared[field]);
    }
  }

  write(path.join(OUT, 'copyright.txt'), metadata.shared.copyright);
  write(path.join(OUT, 'primary_category.txt'), metadata.shared.primaryCategory.toUpperCase());
  write(path.join(OUT, 'secondary_category.txt'), metadata.shared.secondaryCategory.toUpperCase());
  write(path.join(OUT, 'review_information', 'notes.txt'), metadata.reviewNotes.text);

  // Screenshots are linked rather than copied. They are the one genuinely large asset here
  // and duplicating twenty-odd megabytes to satisfy a path convention would mean a second
  // set that can drift from the composed one.
  fs.rmSync(SCREENSHOT_OUT, { recursive: true, force: true });
  fs.mkdirSync(SCREENSHOT_OUT, { recursive: true });
  let linked = 0;
  for (const locale of locales) {
    const source = path.join(SCREENSHOT_SOURCE, locale);
    if (!fs.existsSync(source)) continue;
    fs.symlinkSync(source, path.join(SCREENSHOT_OUT, locale));
    linked += 1;
  }

  console.log(`Wrote fastlane/metadata for ${locales.length} localization(s).`);
  console.log(`Linked fastlane/screenshots for ${linked} localization(s).`);
  console.log(
    `\nLocalizations without their own screenshots inherit the primary language's, so the\n` +
      `remaining ${locales.length - linked} are not a blocker.\n\n` +
      `Note before running deliver: its list of accepted languages is compiled into the gem.\n` +
      `Bangla, Urdu, Malayalam and Tamil are recent App Store additions, so an older\n` +
      `fastlane will reject those four directories as unknown while the API accepts them.\n` +
      `Check with: bundle exec fastlane deliver --verbose`,
  );
}

main();
