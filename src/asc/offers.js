#!/usr/bin/env node
'use strict';

/**
 * Subscription offers: the free trial and everything beside it.
 *
 *   store-kit asc offers                  what every product currently offers
 *   store-kit asc offers --dry-run
 *   store-kit asc offers --apply          create the trial described in metadata.json
 *
 * The Play side of this repo has created trial offers from `inAppPurchases.trialOffer` since
 * the beginning; the App Store side did not, so the iOS trial was a thing somebody set in the
 * console once and nobody could verify afterwards. That asymmetry is the whole reason this
 * exists: a trial promised in twenty three languages of listing copy and missing on one
 * platform is a refund request, not a bug report.
 *
 * Introductory offers are what a trial is on the App Store. They are per territory, and an
 * offer created with no territory relationship covers all of them, which is what almost every
 * app wants and what this writes.
 *
 * Promotional offers, offer codes and win-back offers are read and reported here but not
 * created. They are campaign objects with start and end dates and audience rules, and a tool
 * that creates one from a config file would be creating a marketing decision from a file
 * nobody reviews for marketing.
 */

const { AppStoreConnect } = require('./api');
const { metadata, resolveApp, resolveSubscriptions } = require('./context');
const { load } = require('../lib/config');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const APPLY = argv.includes('--apply');

/** Apple's duration enum for a trial length in days. Only these are accepted. */
const DURATION_FOR_DAYS = {
  3: 'THREE_DAYS',
  7: 'ONE_WEEK',
  14: 'TWO_WEEKS',
  30: 'ONE_MONTH',
  60: 'TWO_MONTHS',
  90: 'THREE_MONTHS',
  180: 'SIX_MONTHS',
  365: 'ONE_YEAR',
};

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN, verbose: VERBOSE });
  const config = load();
  const app = await resolveApp(client);
  const { subscriptions } = await resolveSubscriptions(client, app.id);

  const trial = config.trialOffer;
  const duration = trial ? DURATION_FOR_DAYS[trial.days] : null;
  if (trial && !duration) {
    throw new Error(
      `A ${trial.days} day trial is not a length Apple accepts. Pick one of ` +
        `${Object.keys(DURATION_FOR_DAYS).join(', ')} days, or drop inAppPurchases.trialOffer.`,
    );
  }

  console.log(`${app.attributes.name}\n`);
  const missing = [];

  for (const sub of subscriptions) {
    const id = sub.attributes.productId;
    const intro = await client.list(`/v1/subscriptions/${sub.id}/introductoryOffers?limit=200`);
    const promo = await client.list(`/v1/subscriptions/${sub.id}/promotionalOffers?limit=200`);
    const codes = await client.list(`/v1/subscriptions/${sub.id}/offerCodes?limit=200`);

    console.log(`  ${id}`);
    if (intro.length === 0) {
      console.log('    introductory   (none)');
      if (trial) missing.push({ sub, id });
    }
    // Grouped, because an introductory offer is per territory and a store selling in a
    // hundred and seventy five of them prints a hundred and seventy five identical lines
    // otherwise. What matters is whether the terms are uniform and how wide they reach.
    const shapes = new Map();
    for (const offer of intro) {
      const a = offer.attributes;
      const key =
        `${a.offerMode} ${a.duration} x${a.numberOfPeriods}` +
        `${a.startDate ? ` from ${a.startDate}` : ''}${a.endDate ? ` to ${a.endDate}` : ''}`;
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
    for (const [shape, count] of shapes) {
      console.log(`    introductory   ${shape}  (${count} territor${count === 1 ? 'y' : 'ies'})`);
    }
    if (promo.length > 0) console.log(`    promotional    ${promo.length}`);
    if (codes.length > 0) console.log(`    offer codes    ${codes.length}`);
  }

  // The check that makes this worth running even when nothing is applied: the listing copy
  // promises a trial in every language, and the products are where that promise is kept.
  if (trial && missing.length > 0 && !APPLY) {
    console.log(
      `\n${missing.length} product(s) have no introductory offer, but ` +
        `inAppPurchases.trialOffer describes a ${trial.days} day trial. ` +
        'Pass --apply to create it.',
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log('\nRead only. Pass --apply to create missing introductory offers.');
    return;
  }

  if (!trial) throw new Error('store/metadata.json has no inAppPurchases.trialOffer to apply.');

  for (const { sub, id } of missing) {
    console.log(`\n${DRY_RUN ? 'Planning' : 'Creating'} ${duration} free trial on ${id}`);
    await client.post('/v1/subscriptionIntroductoryOffers', {
      data: {
        type: 'subscriptionIntroductoryOffers',
        attributes: { offerMode: 'FREE_TRIAL', duration, numberOfPeriods: 1 },
        // No territory relationship, so it applies everywhere the subscription is sold.
        relationships: { subscription: { data: { type: 'subscriptions', id: sub.id } } },
      },
    });
  }

  if (missing.length === 0) console.log('\nEvery product already has an introductory offer.');
  else console.log(DRY_RUN ? '\nDry run. Nothing was written.' : '\nDone.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
