#!/usr/bin/env node
'use strict';

/**
 * Pushes the subscription group and product localizations.
 *
 *   node scripts/asc/push-subscriptions.js --dry-run
 *   node scripts/asc/push-subscriptions.js
 *
 * Two different audiences read these strings, which is why they are worth translating even
 * where the app itself is not.
 *
 * The group display name is what appears in iOS Settings above the plans, so it is the
 * line someone scans when they have decided to cancel and are looking for the right row.
 * Finding it in a language they do not read, next to the charge they are trying to stop,
 * is how a cancellation turns into a chargeback and a one star review.
 *
 * The product name and description appear inside the system purchase sheet, which is the
 * last thing between the user and their money. The app can be in English there and still
 * be fine; that sheet cannot.
 */

const { AppStoreConnect, AscError } = require('./api');
const { upsert } = require('./upsert');
const { metadata, resolveApp, resolveSubscriptions } = require('./context');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN, verbose: VERBOSE });

  const app = await resolveApp(client);
  const { group, subscriptions } = await resolveSubscriptions(client, app.id);

  const failures = [];

  const groupNames = metadata.inAppPurchases.subscriptionGroupLocalizations;
  const existingGroup = new Map(
    (await client.list(`/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations`)).map(
      (l) => [l.attributes.locale, l],
    ),
  );

  console.log(
    `${DRY_RUN ? 'Planning' : 'Pushing'} group "${group.attributes.referenceName}" ` +
      `in ${Object.keys(groupNames).length} language(s).\n`,
  );

  for (const [locale, name] of Object.entries(groupNames)) {
    try {
      const result = await upsert(client, {
        existing: existingGroup.get(locale),
        path: '/v1/subscriptionGroupLocalizations',
        type: 'subscriptionGroupLocalizations',
        parent: { name: 'subscriptionGroup', type: 'subscriptionGroups', id: group.id },
        // customAppName is left unset on purpose. Unset, iOS shows the app's own name for
        // that storefront, which is already localized; setting it would mean maintaining a
        // second copy of the app name that can only ever drift from the first.
        attributes: { locale, name },
      });
      console.log(`  group  ${locale.padEnd(8)} ${result.padEnd(7)} "${name}"`);
    } catch (error) {
      if (!(error instanceof AscError)) throw error;
      failures.push({ what: `group ${locale}`, message: error.message });
      console.log(`  group  ${locale.padEnd(8)} FAILED`);
    }
  }

  for (const subscription of subscriptions) {
    const productId = subscription.attributes.productId;
    const existing = new Map(
      (await client.list(`/v1/subscriptions/${subscription.id}/subscriptionLocalizations`)).map(
        (l) => [l.attributes.locale, l],
      ),
    );

    console.log(`\n${productId}`);

    for (const [locale, text] of Object.entries(subscription.local.localizations)) {
      try {
        const result = await upsert(client, {
          existing: existing.get(locale),
          path: '/v1/subscriptionLocalizations',
          type: 'subscriptionLocalizations',
          parent: { name: 'subscription', type: 'subscriptions', id: subscription.id },
          attributes: { locale, name: text.displayName, description: text.description },
        });
        console.log(`  ${locale.padEnd(8)} ${result.padEnd(7)} "${text.displayName}"`);
      } catch (error) {
        if (!(error instanceof AscError)) throw error;
        failures.push({ what: `${productId} ${locale}`, message: error.message });
        console.log(`  ${locale.padEnd(8)} FAILED`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} localization(s) failed:\n`);
    for (const failure of failures) {
      console.error(`  ${failure.what}`);
      console.error(`${failure.message.split('\n').slice(1).join('\n')}\n`);
    }
    process.exit(1);
  }

  console.log(
    DRY_RUN
      ? '\nDry run. Nothing was written. Remove --dry-run to apply.'
      : '\nDone.',
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
