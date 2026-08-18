#!/usr/bin/env node
'use strict';

/**
 * Pushes store/metadata.json into App Store Connect, one localization at a time.
 *
 *   node scripts/asc/push-metadata.js --dry-run
 *   node scripts/asc/push-metadata.js
 *   node scripts/asc/push-metadata.js --only tr,de-DE,ur
 *
 * Metadata is split across two objects and the split is not obvious. Name, subtitle and
 * the privacy policy URL belong to the App Info, which is not versioned: editing them
 * edits the listing itself. Description, keywords, promotional text and What's New belong
 * to the version. This writes both, because "the listing" as a person thinks of it spans
 * the two.
 *
 * A failure on one localization does not stop the others. Apple rejects an app name that
 * another app already holds in that storefront, and it only tells you at write time, so a
 * run over twenty-three languages is expected to surface a few. Collecting them and
 * reporting at the end means one round of renaming instead of twenty-three runs.
 */

const { AppStoreConnect, AscError } = require('./api');
const { upsert } = require('./upsert');
const {
  metadata,
  resolveApp,
  resolveAppInfo,
  resolveVersion,
} = require('./context');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');

const onlyFlag = argv.indexOf('--only');
const ONLY = onlyFlag === -1 ? null : new Set(argv[onlyFlag + 1].split(','));

const localesIn = (source) =>
  Object.keys(source).filter((key) => !key.startsWith('_') && source[key].name !== undefined);

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN, verbose: VERBOSE });

  const app = await resolveApp(client);
  const info = await resolveAppInfo(client, app.id);
  const version = await resolveVersion(client, app.id);

  const allVersions = await client.list(`/v1/apps/${app.id}/appStoreVersions`);
  // What's New has no field on a listing's first version, and sending one is rejected
  // rather than ignored. Nothing in metadata.json is lost; the copy is simply not due yet.
  const isFirstVersion = allVersions.length <= 1;

  const infoLocalizations = new Map(
    (await client.list(`/v1/appInfos/${info.id}/appInfoLocalizations`)).map((l) => [
      l.attributes.locale,
      l,
    ]),
  );
  const versionLocalizations = new Map(
    (await client.list(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).map(
      (l) => [l.attributes.locale, l],
    ),
  );

  const locales = localesIn(metadata).filter((locale) => !ONLY || ONLY.has(locale));

  console.log(
    `${DRY_RUN ? 'Planning' : 'Pushing'} ${locales.length} localization(s) to ` +
      `${app.attributes.name} version ${version.attributes.versionString}` +
      `${isFirstVersion ? " (first version, What's New skipped)" : ''}.\n`,
  );

  const failures = [];

  for (const locale of locales) {
    const block = metadata[locale];
    const shared = metadata.shared;

    try {
      const infoResult = await upsert(client, {
        existing: infoLocalizations.get(locale),
        path: '/v1/appInfoLocalizations',
        type: 'appInfoLocalizations',
        parent: { name: 'appInfo', type: 'appInfos', id: info.id },
        listPath: `/v1/appInfos/${info.id}/appInfoLocalizations`,
        locale,
        attributes: {
          locale,
          name: block.name,
          subtitle: block.subtitle,
          privacyPolicyUrl: block.privacyPolicyUrl ?? shared.privacyPolicyUrl,
        },
      });

      const versionAttributes = {
        locale,
        description: block.description,
        keywords: block.keywords,
        promotionalText: block.promotionalText,
        supportUrl: block.supportUrl ?? shared.supportUrl,
        marketingUrl: block.marketingUrl ?? shared.marketingUrl,
      };
      if (!isFirstVersion && block.whatsNew) versionAttributes.whatsNew = block.whatsNew;

      const versionResult = await upsert(client, {
        existing: versionLocalizations.get(locale),
        path: '/v1/appStoreVersionLocalizations',
        type: 'appStoreVersionLocalizations',
        parent: { name: 'appStoreVersion', type: 'appStoreVersions', id: version.id },
        listPath: `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`,
        locale,
        attributes: versionAttributes,
      });

      console.log(
        `  ${locale.padEnd(8)} info ${infoResult.padEnd(7)} version ${versionResult.padEnd(7)} ` +
          `"${block.name}"`,
      );
    } catch (error) {
      if (!(error instanceof AscError)) throw error;
      failures.push({ locale, name: block.name, message: error.message });
      console.log(`  ${locale.padEnd(8)} FAILED`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} localization(s) failed:\n`);
    for (const failure of failures) {
      console.error(`  ${failure.locale}  name "${failure.name}"`);
      console.error(`${failure.message.split('\n').slice(1).join('\n')}\n`);
    }
    // The likeliest cause is worth naming, but only as a hypothesis. Apple's own detail is
    // printed above and is the thing to read first.
    if (failures.some((f) => /already been used|duplicate/i.test(f.message))) {
      console.error(
        'If the detail above mentions the name: an app name has to be unique across the\n' +
          'whole App Store for that storefront, and Apple only checks at write time.\n' +
          'Rename the failing ones in store/metadata.json, run npm run check:store, then\n' +
          're-run with --only <locales>.',
      );
    }
    console.error('Re-run just the failures with: npm run asc:metadata -- --only ' +
      failures.map((f) => f.locale).join(','));
    process.exit(1);
  }

  console.log(
    DRY_RUN
      ? '\nDry run. Nothing was written. Remove --dry-run to apply.'
      : `\nDone. ${locales.length} localization(s) written.`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
