#!/usr/bin/env node
'use strict';

/**
 * Reads the Play listing back and diffs it against store/metadata.json and store/pricing.json.
 *
 *   node scripts/play/verify.js
 *
 * The mirror of `scripts/asc/verify.js`, and it exists for the same reason: "it pushed" and
 * "it is correct" are different claims, and only one of them is worth trusting. A push
 * reports what it sent. This reports what Google actually holds.
 *
 * Writes nothing. It opens an edit because listings and images are only readable inside one,
 * then abandons it.
 */

const path = require('node:path');

const { PlayApi } = require('./api');
const { readThroughEdit } = require('./edit');
const { toPlayRegion, fromMoney } = require('./regions');

const ROOT = require('../lib/root').root();
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));
const pricing = require(path.join(ROOT, 'store', 'pricing.json'));

// Products with their term and Play base plan id filled in, so this file never has to know
// what any particular app calls its subscriptions.
const { products: PRODUCTS } = require('../lib/config').load();

const problems = [];
const note = (message) => problems.push(message);

async function main() {
  const api = new PlayApi({ verbose: process.argv.includes('--verbose') });
  const play = metadata.play;
  const ascLocales = Object.keys(metadata).filter(
    (key) => !key.startsWith('_') && metadata[key].name !== undefined,
  );

  // ---- listing text and artwork -------------------------------------------------
  await readThroughEdit(api, async (editId) => {
    const listings = await api.get(`/applications/${api.package}/edits/${editId}/listings`);
    const live = new Map((listings?.listings ?? []).map((l) => [l.language, l]));
    console.log(`Listing: ${live.size} localization(s) live.\n`);

    for (const locale of ascLocales) {
      const playLocale = play.locales[locale];
      const block = metadata[locale];
      const remote = live.get(playLocale);
      if (!remote) {
        note(`[${locale} -> ${playLocale}] not present on Play`);
        continue;
      }
      if (remote.title !== block.name) {
        note(`[${playLocale}] title is "${remote.title}", expected "${block.name}"`);
      }
      if (remote.shortDescription !== block.play.shortDescription) {
        note(`[${playLocale}] shortDescription differs from metadata.json`);
      }
      if (remote.fullDescription !== block.description) {
        note(`[${playLocale}] fullDescription differs from metadata.json`);
      }

      const images = await api.get(
        `/applications/${api.package}/edits/${editId}/listings/${playLocale}/phoneScreenshots`,
      );
      const count = (images?.images ?? []).length;
      // Two is Play's minimum to publish; more than eight is the append bug in push-images.js
      // having happened, which is silent on the store and looks like a set nobody curated.
      if (count < 2) note(`[${playLocale}] has ${count} phone screenshot(s), Play wants 2+`);
      if (count > 8) note(`[${playLocale}] has ${count} phone screenshots, Play caps at 8`);
      console.log(`  ${playLocale.padEnd(8)} "${remote.title}"  ${count} screenshots`);
    }
  });

  // ---- subscriptions and prices --------------------------------------------------
  const subs = await api.list(`/applications/${api.package}/subscriptions`, 'subscriptions');
  const live = new Map(subs.map((sub) => [sub.productId, sub]));
  console.log(`\nSubscriptions: ${live.size} live.\n`);

  // Play does not sell everywhere Apple does, so pricing.json naming a territory is not on
  // its own a reason to expect a price. Brunei and mainland China are both in that file and
  // neither is a Play region, and reporting them as missing prices every run would train
  // whoever reads this to ignore the output. Google's own sellable list is the arbiter.
  const sellable = new Set(
    Object.keys(
      (
        await api.post(`/applications/${api.package}/pricing:convertRegionPrices`, {
          price: { currencyCode: 'USD', units: '1', nanos: 0 },
        })
      )?.convertedRegionPrices ?? {},
    ),
  );

  const expectedRegions = new Set();
  const notSold = [];
  for (const alpha3 of Object.keys(pricing.territories)) {
    let region;
    try {
      region = toPlayRegion(alpha3);
    } catch {
      note(`pricing.json names ${alpha3}, which has no Play region code`);
      continue;
    }
    if (sellable.has(region)) expectedRegions.add(region);
    else notSold.push(`${alpha3} (${region})`);
  }
  if (notSold.length > 0) {
    console.log(`  not sold on Play, so not priced: ${notSold.join(', ')}\n`);
  }

  for (const product of PRODUCTS) {
    const remote = live.get(product.productId);
    if (!remote) {
      note(`${product.productId} does not exist on Play`);
      continue;
    }

    const listingCount = (remote.listings ?? []).length;
    if (listingCount !== ascLocales.length) {
      note(
        `${product.productId} has ${listingCount} listing(s), expected ${ascLocales.length}`,
      );
    }

    for (const plan of remote.basePlans ?? []) {
      // The check that would have caught the worst bug this script has seen. pricing.json
      // deliberately names only the territories that get a discount and lets the rest keep
      // the base price, which is how the App Store behaves. Play does not: a region with no
      // config and no `otherRegionsConfig` is simply not sold to. Without this, the product
      // was live and correct looking in sixty one countries and unsellable in the United
      // States, the United Kingdom, Germany, France, Canada and Australia, and nothing in
      // the output said so.
      if (!plan.otherRegionsConfig?.usdPrice) {
        note(
          `${product.productId}/${plan.basePlanId} has no otherRegionsConfig, so every ` +
            'country pricing.json does not name, the United States included, cannot buy it',
        );
      }

      const configs = plan.regionalConfigs ?? [];
      const priced = new Set(configs.map((config) => config.regionCode));
      const missing = [...expectedRegions].filter((region) => !priced.has(region));
      console.log(
        `  ${product.productId.padEnd(24)} ${plan.basePlanId.padEnd(18)} ${plan.state ?? '?'}  ` +
          `${configs.length} region(s)`,
      );
      if (missing.length > 0) {
        note(
          `${product.productId}/${plan.basePlanId} has no price in ${missing.length} of the ` +
            `territories pricing.json names: ${missing.slice(0, 8).join(', ')}` +
            `${missing.length > 8 ? ', ...' : ''}`,
        );
      }

      // Offers are a sub-resource and do not come back on the subscription, so they have to
      // be asked for. Reading `plan.offerIds` returns undefined on every base plan and made
      // this report "no offer" for offers that were sitting right there.
      const offers = await api.list(
        `/applications/${api.package}/subscriptions/${product.productId}` +
          `/basePlans/${plan.basePlanId}/offers`,
        'subscriptionOffers',
      );
      if (/free trial/i.test(product.introductoryOffer ?? '') && offers.length === 0) {
        note(
          `${product.productId}/${plan.basePlanId} has no offer, but the listing copy promises ` +
            'a free trial in every language',
        );
      } else if (offers.length > 0) {
        console.log(
          `  ${''.padEnd(24)} ${''.padEnd(18)} offers: ` +
            offers.map((o) => `${o.offerId} (${o.state ?? '?'})`).join(', '),
        );
      }
    }

    // Spot check the invariant against what Google actually holds, not against what the
    // pricing script computed. A price written by hand in the console would pass every check
    // in push-pricing.js and fail here, which is the point of reading it back.
    // Matched by term rather than by product id: the ids differ in every app, the terms do
    // not, and an id typed in here is an id that silently stops matching in the next repo.
    const monthlyProduct = PRODUCTS.find((p) => p.term === 'monthly');
    const annualProduct = PRODUCTS.find((p) => p.term === 'annual');
    const monthly = monthlyProduct ? live.get(monthlyProduct.productId) : null;
    const annual = annualProduct ? live.get(annualProduct.productId) : null;
    if (monthly && annual && product.term === 'annual') {
      const monthlyByRegion = new Map(
        (monthly.basePlans?.[0]?.regionalConfigs ?? []).map((c) => [c.regionCode, c.price]),
      );
      const { min, max } = pricing.invariants.annualShareOfTwelveMonthly;
      for (const config of annual.basePlans?.[0]?.regionalConfigs ?? []) {
        const m = monthlyByRegion.get(config.regionCode);
        if (!m) continue;
        const share = fromMoney(config.price) / (fromMoney(m) * 12);
        if (share < min || share > max) {
          note(
            `${config.regionCode}: annual is ${(share * 100).toFixed(0)}% of twelve monthly on ` +
              `Play, outside ${min * 100}-${max * 100}%`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\nVerification found ${problems.length} problem(s):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nPlay listing matches store/metadata.json and store/pricing.json.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
