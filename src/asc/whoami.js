#!/usr/bin/env node
'use strict';

/**
 * Reads the current state of the listing out of App Store Connect. Writes nothing.
 *
 * Run this first. It answers the only question that matters before a push, which is
 * whether the credential works and points at the right app, and it prints the ids the
 * other scripts resolve so a surprising result later can be checked against what was
 * actually there.
 *
 *   node scripts/asc/whoami.js
 *   node scripts/asc/whoami.js --locales   also asks Apple which locale codes it accepts
 */

const { AppStoreConnect, AscError } = require('./api');
const { metadata, resolveApp, resolveAppInfo, resolveVersion, resolveSubscriptions } = require('./context');

/**
 * Asks the API whether a locale code is one it will accept, by creating a localization in
 * that language and deleting it again.
 *
 * There is no endpoint that lists the valid codes, and Apple's documentation page renders
 * client side, so a list copied into this repo goes stale the next time Apple adds a
 * language. Worse, the published list is not the same as the accepted list: the App Store
 * localizations help page prints Urdu, Bangla, Malayalam and Tamil without a region, and
 * the API rejects all four unless they are written ur-PK, bn-BD, ml-IN and ta-IN.
 *
 * Creating and deleting is heavy-handed for a check, and it is that way because two lighter
 * probes both produced confident wrong answers first:
 *
 *  - Reading back an invalid `filter[locale]` and pulling codes out of the error text with
 *    a regex. It reported "fi, lt, er, lo, ca" as valid locales, which are fragments of the
 *    words "filter", "value" and "locale" in the surrounding prose.
 *  - Posting a body with no parent relationship, expecting the locale to be judged. The
 *    missing relationship is rejected first, so every code on earth came back valid.
 *
 * Only a request that would really have succeeded proves the code is real. The description
 * has to clear Apple's ten character minimum or the request fails on that instead and the
 * locale is never reached, which is the third way this went wrong.
 */
async function probeLocale(client, versionId, candidate) {
  try {
    const created = await client.post('/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale: candidate, description: 'Locale probe, removed immediately.' },
        relationships: {
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
    await client.delete(`/v1/appStoreVersionLocalizations/${created.data.id}`);
    return { candidate, accepted: true };
  } catch (error) {
    if (!(error instanceof AscError)) throw error;
    const detail = error.errors.map((e) => e.detail).join(' | ');
    // An existing localization is proof the code is fine, which is the common case for
    // every language already pushed.
    if (/already exists/i.test(detail)) return { candidate, accepted: true };
    return { candidate, accepted: false, detail };
  }
}

async function main() {
  const client = new AppStoreConnect({ verbose: true });

  const app = await resolveApp(client);
  console.log(`App          ${app.attributes.name}`);
  console.log(`Bundle       ${app.attributes.bundleId}`);
  console.log(`Apple ID     ${app.id}`);
  console.log(`Primary      ${app.attributes.primaryLocale}`);
  console.log(`SKU          ${app.attributes.sku}`);

  const info = await resolveAppInfo(client, app.id);
  const infoLocalizations = await client.list(`/v1/appInfos/${info.id}/appInfoLocalizations`);
  console.log(`\nApp Info     ${info.id}`);
  console.log(`  ${infoLocalizations.length} localization(s): ` +
    infoLocalizations.map((l) => l.attributes.locale).sort().join(', '));

  const version = await resolveVersion(client, app.id);
  const state = version.attributes.appVersionState ?? version.attributes.appStoreState;
  const versionLocalizations = await client.list(
    `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`,
  );
  console.log(`\nVersion      ${version.attributes.versionString} (${state}) ${version.id}`);
  console.log(`  ${versionLocalizations.length} localization(s): ` +
    versionLocalizations.map((l) => l.attributes.locale).sort().join(', '));

  const { group, subscriptions } = await resolveSubscriptions(client, app.id);
  console.log(`\nGroup        ${group.attributes.referenceName} ${group.id}`);
  const groupLocalizations = await client.list(
    `/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations`,
  );
  console.log(`  ${groupLocalizations.length} localization(s): ` +
    groupLocalizations.map((l) => l.attributes.locale).sort().join(', '));

  for (const subscription of subscriptions) {
    const localizations = await client.list(
      `/v1/subscriptions/${subscription.id}/subscriptionLocalizations`,
    );
    const prices = await client.list(
      `/v1/subscriptions/${subscription.id}/prices?include=territory&limit=200`,
    );
    console.log(`\n  ${subscription.attributes.productId}  ${subscription.id}`);
    console.log(`    state       ${subscription.attributes.state}`);
    console.log(`    period      ${subscription.attributes.subscriptionPeriod}`);
    console.log(`    ${localizations.length} localization(s): ` +
      localizations.map((l) => l.attributes.locale).sort().join(', '));
    console.log(`    ${prices.length} territory price(s) set`);
  }

  const target = Object.keys(metadata).filter(
    (key) => !key.startsWith('_') && metadata[key].name !== undefined,
  );
  console.log(`\nstore/metadata.json carries ${target.length} localization(s).`);

  if (process.argv.includes('--locales')) {
    // Every locale this repo intends to ship, checked one at a time against the API. Slower
    // than reading a list, but it is the difference between believing "ur" is accepted and
    // knowing it, and the cost of being wrong is a push that half lands.
    const wanted = Object.keys(metadata).filter(
      (key) => !key.startsWith('_') && metadata[key].name !== undefined,
    );
    console.log('\nChecking each locale in store/metadata.json against the API:');

    const rejected = [];
    for (const candidate of wanted) {
      const result = await probeLocale(client, version.id, candidate);
      if (!result.accepted) rejected.push(result);
      console.log(`  ${result.accepted ? 'ok     ' : 'REJECT '}${candidate}`);
    }

    if (rejected.length > 0) {
      console.log(`\n${rejected.length} rejected. Apple's message for the first one:`);
      console.log(`  ${rejected[0].detail}`);
    } else {
      console.log('\nAll accepted.');
    }
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
