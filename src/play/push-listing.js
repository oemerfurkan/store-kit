#!/usr/bin/env node
'use strict';

/**
 * Pushes the Play store listing out of store/metadata.json.
 *
 *   node scripts/play/push-listing.js --dry-run
 *   node scripts/play/push-listing.js
 *   node scripts/play/push-listing.js --only tr,de-DE
 *
 * Three fields per locale, and only one of them is written for Play alone. `title` is the
 * App Store name and `fullDescription` is the App Store description, both unchanged, because
 * a listing that says something different on each store is a listing somebody forgot to
 * update. `shortDescription` has no App Store counterpart and is written in metadata.json
 * under each locale's `play` block.
 *
 * Locales are named differently on the two stores and the mapping lives in
 * `metadata.play.locales`. `npm run check:store` fails if any ASC locale is unmapped or if
 * two of them claim the same Play code, so by the time this runs the mapping is known good.
 *
 * Unlike the ASC pusher this cannot half-succeed: everything goes inside one edit, and a
 * failure on locale nineteen abandons the edit and leaves all twenty three as they were.
 * That is why there is no per-locale failure collection here and there is one there.
 */

const path = require('node:path');

const { PlayApi } = require('./api');
const { withEdit } = require('./edit');

const ROOT = require('../lib/root').root();
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const onlyFlag = argv.indexOf('--only');
const ONLY = onlyFlag === -1 ? null : new Set(argv[onlyFlag + 1].split(','));

const ascLocales = () =>
  Object.keys(metadata).filter((key) => !key.startsWith('_') && metadata[key].name !== undefined);

async function main() {
  const api = new PlayApi({ dryRun: DRY_RUN, verbose: VERBOSE });
  const play = metadata.play;
  if (!play) throw new Error('store/metadata.json has no play block. Run npm run check:store.');

  const locales = ascLocales().filter((locale) => !ONLY || ONLY.has(locale));
  if (ONLY) {
    const unknown = [...ONLY].filter((locale) => !ascLocales().includes(locale));
    if (unknown.length > 0) throw new Error(`--only names unknown locales: ${unknown.join(', ')}`);
  }

  console.log(
    `${DRY_RUN ? 'Validating' : 'Pushing'} ${locales.length} localization(s) to ` +
      `${api.package}.\n`,
  );

  await withEdit(
    api,
    async (editId) => {
      // Written once, not per locale. `defaultLanguage` decides which listing Play falls back
      // to for a device whose language has no localization, which is every language outside
      // the twenty three.
      await api.put(`/applications/${api.package}/edits/${editId}/details`, {
        defaultLanguage: play.locales[play.defaultLanguage],
        contactEmail: play.contactEmail,
        contactWebsite: play.contactWebsite,
      });

      for (const locale of locales) {
        const block = metadata[locale];
        const playLocale = play.locales[locale];
        await api.put(
          `/applications/${api.package}/edits/${editId}/listings/${playLocale}`,
          {
            language: playLocale,
            title: block.name,
            shortDescription: block.play.shortDescription,
            fullDescription: block.description,
          },
        );
        console.log(`  ${locale.padEnd(8)} -> ${playLocale.padEnd(7)} "${block.name}"`);
      }
    },
    { label: 'listing', changesNotSentForReview: true },
  );

  console.log(
    DRY_RUN
      ? '\nDry run. The edit was validated by Google and then abandoned.'
      : `\nDone. ${locales.length} localization(s) written.`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
