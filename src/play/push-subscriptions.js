#!/usr/bin/env node
'use strict';

/**
 * Creates or updates the Play subscriptions described by store/metadata.json.
 *
 *   store-kit play subscriptions --dry-run
 *   store-kit play subscriptions
 *
 * Play's model is three levels deep where App Store Connect's is one:
 *
 *   <productId>
 *     basePlan  <term>-autorenew    P1M or P1Y
 *       offer   free-trial-<n>d     P<n>D at 100% off, new subscribers only
 *
 * The product ids match iOS exactly, whatever they are: the same string identifies the
 * product in both stores and in RevenueCat. The base plan ids are not an implementation
 * detail either, because **RevenueCat identifies a Play subscription as
 * `productId:basePlanId`**, so they are part of the contract with the RevenueCat catalog
 * and renaming one silently unbinds a product there. Both come from metadata.json through
 * the config layer, which derives `<term>-autorenew` unless the app names its own.
 *
 * One thing that has no undo. A Play subscription id cannot be deleted or reused: the most
 * you can do is deactivate it, and the id is then spent for the life of the app. So this
 * script does not create anything on its own the first time. Run it with `--dry-run` and read
 * what it plans, then run it for real.
 *
 * Prices are not set here. `push-pricing.js` owns the regional configs, because the price
 * decision lives in store/pricing.json and reads from a different source of truth.
 */

const path = require('node:path');

const { PlayApi, PlayError } = require('./api');
const { currentRegionsVersion } = require('./regions');

const ROOT = require('../lib/root').root();
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');

// Base plan shape and trial length, derived from store/metadata.json by the config layer.
// The period is what makes a base plan monthly or annual, and the offer id is part of the
// RevenueCat store identifier, so both are config rather than convention with no override.
const CONFIG = require('../lib/config').load();
const TRIAL = CONFIG.trialOffer;
const TRIAL_OFFER_ID = TRIAL?.offerId ?? null;
const TRIAL_PERIOD = TRIAL?.period ?? null;

/** Play locale for an ASC locale, or null when the listing does not carry that language. */
const playLocale = (locale) => metadata.play?.locales?.[locale] ?? null;

function listingsFor(product) {
  const listings = [];
  for (const [locale, text] of Object.entries(product.localizations)) {
    const language = playLocale(locale);
    if (!language) continue;
    listings.push({
      languageCode: language,
      title: text.displayName,
      // Play calls this the benefit line and shows it in the purchase sheet. ASC's
      // description is the same sentence for the same place, so it is reused rather than
      // written twice and left to drift.
      description: text.description,
    });
  }
  return listings;
}

async function main() {
  const api = new PlayApi({ dryRun: DRY_RUN, verbose: VERBOSE });
  const products = CONFIG.products;
  if (products.length === 0) throw new Error('store/metadata.json lists no in-app purchases.');

  const regionsVersion = await currentRegionsVersion(api);
  const stamp = `regionsVersion.version=${encodeURIComponent(regionsVersion)}`;

  const existing = new Map(
    (await api.list(`/applications/${api.package}/subscriptions`, 'subscriptions')).map((sub) => [
      sub.productId,
      sub,
    ]),
  );
  console.log(
    `${DRY_RUN ? 'Planning' : 'Pushing'} ${products.length} subscription(s) to ${api.package}. ` +
      `${existing.size} already exist.\n`,
  );

  for (const product of products) {
    const plan = { basePlanId: product.playBasePlanId, period: product.playPeriod };

    const body = {
      packageName: api.package,
      productId: product.productId,
      listings: listingsFor(product),
      basePlans: [
        {
          basePlanId: plan.basePlanId,
          state: 'DRAFT',
          autoRenewingBasePlanType: {
            billingPeriodDuration: plan.period,
            // Play's default. Named rather than omitted so a future change to the default
            // cannot silently change what subscribers are charged on renewal.
            gracePeriodDuration: 'P0D',
            resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
            prorationMode: 'SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE',
          },
          // Regional configs are written by push-pricing.js, which owns the price decision.
          regionalConfigs: [],
        },
      ],
    };

    const verb = existing.has(product.productId) ? 'update' : 'create';
    if (verb === 'create') {
      await api.post(
        `/applications/${api.package}/subscriptions?productId=${product.productId}&${stamp}`,
        body,
      );
    } else {
      // A full-resource patch would wipe the regional configs push-pricing.js wrote, so the
      // mask names only what this script owns.
      await api.patch(
        `/applications/${api.package}/subscriptions/${product.productId}` +
          `?updateMask=listings&allowMissing=true&${stamp}`,
        body,
      );
    }
    console.log(
      `  ${verb.padEnd(6)} ${product.productId.padEnd(24)} ${plan.basePlanId} ${plan.period} ` +
        `(${body.listings.length} listings)`,
    );

    // The seven day trial. Recorded in metadata.json as `introductoryOffer` and checked by
    // npm run check:store, because the listing copy promises it in every language and copy
    // that promises a trial the store will not give is a refund request.
    if (!/free trial/i.test(product.introductoryOffer ?? '')) {
      console.log(`         no trial recorded for ${product.productId}, offer skipped`);
      continue;
    }

    // An offer can only be sold where its base plan is sold, so the regional configs have to
    // exist before this can name them. They are written by push-pricing.js, which needs the
    // subscription to exist first, so the two scripts interlock: subscriptions, pricing, then
    // subscriptions again for the offers. Skipping loudly is better than a 400 that reads
    // like a payload bug when it is really an ordering one.
    const live = await api.get(
      `/applications/${api.package}/subscriptions/${product.productId}`,
    );
    const regions = (live?.basePlans ?? [])
      .find((b) => b.basePlanId === plan.basePlanId)
      ?.regionalConfigs?.map((config) => config.regionCode) ?? [];

    if (regions.length === 0) {
      console.log(
        `         no prices yet, offer skipped. Run npm run play:pricing, then this again.`,
      );
      continue;
    }

    const offerPath =
      `/applications/${api.package}/subscriptions/${product.productId}` +
      `/basePlans/${plan.basePlanId}/offers`;
    const offerBody = {
      packageName: api.package,
      productId: product.productId,
      basePlanId: plan.basePlanId,
      offerId: TRIAL_OFFER_ID,
      // New subscribers only. Play takes two scopes here, `thisSubscription` and
      // `anySubscriptionInApp`, and the second is the one that matches iOS: Apple decides
      // introductory offer eligibility per subscription *group*, so someone who trials the
      // monthly and cancels cannot come back for a second trial on the annual. Scoping to
      // this subscription alone would hand out two free weeks to anyone who switched plans.
      targeting: { acquisitionRule: { scope: { anySubscriptionInApp: {} } } },
      phases: [
        {
          duration: TRIAL_PERIOD,
          recurrenceCount: 1,
          // Free is declared per region rather than once for the offer. There is no
          // `freePriceOverride`; an empty `free` object is how Play spells "no charge for
          // this phase here".
          regionalConfigs: regions.map((regionCode) => ({ regionCode, free: {} })),
          // And again for everywhere the base plan sells but pricing.json does not name.
          // Without this the trial covers the sixty one discounted countries and stops, so
          // the United States could buy the subscription at full price and never see the
          // free week the store listing promises in all twenty three languages. Same trap as
          // the base plan's own otherRegionsConfig, one level down.
          otherRegionsConfig: { free: {} },
        },
      ],
      regionalConfigs: regions.map((regionCode) => ({ regionCode, newSubscriberAvailability: true })),
      otherRegionsConfig: { otherRegionsNewSubscriberAvailability: true },
    };

    try {
      await api.post(`${offerPath}?offerId=${TRIAL_OFFER_ID}&${stamp}`, offerBody);
      console.log(
        `         offer ${TRIAL_OFFER_ID} ${TRIAL_PERIOD} free in ${regions.length} regions + rest`,
      );
    } catch (error) {
      if (!(error instanceof PlayError) || error.status !== 409) throw error;
      // Updating rather than reporting "already exists" and moving on. An offer created by an
      // earlier run of this script can be missing whatever the script learned since, and the
      // first version of it left `otherRegionsConfig` unset, which quietly excluded every
      // country pricing.json does not name from the free trial.
      await api.patch(
        `${offerPath}/${TRIAL_OFFER_ID}` +
          `?updateMask=phases,regionalConfigs,otherRegionsConfig,targeting&${stamp}`,
        offerBody,
      );
      console.log(
        `         offer ${TRIAL_OFFER_ID} updated, ${regions.length} regions + rest`,
      );
    }
  }

  console.log(
    DRY_RUN
      ? '\nDry run. Nothing was written. Product ids cannot be deleted once created, so read ' +
          'the plan above before removing the flag.'
      : '\nDone. Base plans are DRAFT: activate them in Play Console once prices are set.',
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
