#!/usr/bin/env node
'use strict';

/**
 * Sets per-region subscription prices from store/pricing.json.
 *
 *   node scripts/play/push-pricing.js --dry-run
 *   node scripts/play/push-pricing.js
 *
 * The reasoning in `store/pricing.json:_method` survives intact here, which is the whole
 * reason that file was written the way it was. It multiplies the store's *own* converted
 * price rather than the dollar figure, and Play has a direct analogue of Apple's
 * equalization:
 *
 *   POST /applications/{pkg}/pricing:convertRegionPrices  { price: {USD <base>} }
 *
 * That returns Google's own converted price for every region it sells in. Multiply by the
 * World Bank price level `factor`, derive the annual price from the monthly one with the same
 * `annualDiscount`, apply the same floor and the same 1.00 cap, and the two stores end up
 * charging the same thing for the same reason.
 *
 * Two differences from the ASC script, both handled in `regions.js`:
 *
 *   - Territory codes. pricing.json speaks Apple's alpha-3; Play speaks alpha-2. An unknown
 *     code throws rather than being skipped, because a skip would silently leave that country
 *     on Google's automatic price, which is exactly what the factors exist to override.
 *   - Rounding. Apple has a ladder of price points and the ASC script snaps to a rung. Play
 *     takes arbitrary micros, so nothing stops a price of 3.47 and the rounding has to be
 *     done here instead.
 */

const path = require('node:path');

const { PlayApi } = require('./api');
const {
  toPlayRegion,
  toMoney,
  fromMoney,
  convertRegionPrices,
  currentRegionsVersion,
} = require('./regions');
const { monthlyTarget } = require('../lib/price-target');

const ROOT = require('../lib/root').root();
const pricing = require(path.join(ROOT, 'store', 'pricing.json'));
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');

// Base plan id and term per product, derived by the config layer from store/metadata.json.
// This used to be a table written out here, which meant every new app had to remember to
// edit two scripts before its first push, and forgetting produced a crash halfway through.
const { products: PRODUCTS } = require('../lib/config').load();

async function main() {
  const api = new PlayApi({ dryRun: DRY_RUN, verbose: VERBOSE });
  const regionsVersion = await currentRegionsVersion(api);

  // Google's own conversion of the base price, for every region it sells in. This is the
  // number the factor multiplies; converting the dollar amount ourselves would reproduce the
  // exchange-rate-only pricing the factors were written to correct.
  const converted = await convertRegionPrices(api, pricing.base.monthlyUSD);
  const auto = converted?.convertedRegionPrices ?? {};
  console.log(`Google converts ${pricing.base.monthlyUSD} USD into ${Object.keys(auto).length} regions.\n`);

  // The base price for every region pricing.json does not name, and the reason this script
  // cannot simply mirror that file.
  //
  // pricing.json omits the high income territories on purpose: its `_method` says they "keep
  // Apple's automatic price", and on the App Store that is true, because Apple equalizes the
  // base into every territory whether you name it or not. Play has no such fallback. A base
  // plan with no regional config for a region is not sold in that region at all, so porting
  // the file faithfully and stopping there left the United States, the United Kingdom,
  // Germany, France, Canada and Australia unsellable, which is every market that actually
  // carries revenue.
  //
  // `otherRegionsConfig` is Play's answer: one USD and one EUR figure that cover everything
  // not listed. Both come from Google's own conversion of the base price rather than from a
  // constant here, for the same reason the per-region prices do.
  const convertedAnnual = await convertRegionPrices(
    api,
    pricing.base.monthlyUSD * 12 * pricing.annualDiscount,
  );

  const otherRegions = {
    monthly: converted?.convertedOtherRegionsPrice,
    annual: convertedAnnual?.convertedOtherRegionsPrice,
  };
  if (!otherRegions.monthly?.usdPrice || !otherRegions.annual?.usdPrice) {
    throw new Error(
      'Play returned no convertedOtherRegionsPrice, so unlisted regions would be left ' +
        'unsellable. Refusing to write a price list that silently drops the United States.',
    );
  }
  console.log(
    '  unlisted regions: ' +
      `${fromMoney(otherRegions.monthly.usdPrice).toFixed(2)} USD / ` +
      `${fromMoney(otherRegions.annual.usdPrice).toFixed(2)} USD per year ` +
      `(${fromMoney(otherRegions.monthly.eurPrice).toFixed(2)} / ` +
      `${fromMoney(otherRegions.annual.eurPrice).toFixed(2)} EUR)\n`,
  );

  const rows = [];
  const unknown = [];

  for (const [alpha3, entry] of Object.entries(pricing.territories)) {
    let region;
    try {
      region = toPlayRegion(alpha3);
    } catch (error) {
      unknown.push(error.message);
      continue;
    }

    const googles = auto[region]?.price;
    if (!googles) {
      // Play does not sell everywhere Apple does. A territory with no converted price is not
      // an error, it is a country this app cannot be sold in on this store.
      rows.push({ region, alpha3, market: entry.market, skipped: 'not a Play region' });
      continue;
    }

    const currency = googles.currencyCode;
    const autoAmount = fromMoney(googles);

    // The factor, the floor and the explicit price all live in scripts/price-target.js now,
    // shared with the App Store script. They used to be written out here and again there, and
    // the two copies did not disagree in code, they disagreed in what they multiplied. The
    // two stores convert a dollar amount into local currency differently, so one file and one
    // factor still produced two different prices in the same country.
    const { target, source } = monthlyTarget(entry, {
      autoPrice: autoAmount,
      currency,
      pricing,
      territory: alpha3,
    });

    // The annual price is derived from the monthly price that was actually *chosen*, not from
    // its own target. store/pricing.json:_annualDiscountNote records why: pricing the two
    // independently lets two roundings compound in the same direction, and that is what put
    // Qatar and Romania at 42 percent on the App Store side. Rounding once, at the end, keeps
    // the relationship true by construction wherever the currency is coarse.
    const monthly = toMoney(target, currency);
    const annual = toMoney(fromMoney(monthly) * 12 * pricing.annualDiscount, currency);

    rows.push({
      region,
      alpha3,
      market: entry.market,
      currency,
      // What the price came out as against the store's own conversion, whichever route set
      // it. For an explicit price this is the fact worth seeing, because it is the number the
      // factor method would have had to be given to produce it.
      factor: fromMoney(monthly) / autoAmount,
      source,
      monthly,
      annual,
    });
  }

  if (unknown.length > 0) {
    console.error('Unmapped territories:\n');
    for (const line of unknown) console.error(`  - ${line}`);
    process.exit(1);
  }

  // The invariant from pricing.json, kept as the backstop it already is. Deriving annual from
  // monthly makes the ratio hold by construction, but the rounding at the end can still move
  // it, and a sparse currency moves it further.
  const { min, max } = pricing.invariants.annualShareOfTwelveMonthly;
  const priced = rows.filter((row) => !row.skipped);
  for (const row of priced) {
    const share = fromMoney(row.annual) / (fromMoney(row.monthly) * 12);
    if (share < min || share > max) {
      console.error(
        `${row.region} ${row.market}: annual is ${(share * 100).toFixed(0)}% of twelve monthly, ` +
          `outside ${min * 100}-${max * 100}%.\n` +
          `  ${row.currency} monthly ${fromMoney(row.monthly)} x12 = ` +
          `${(fromMoney(row.monthly) * 12).toFixed(2)}, annual ${fromMoney(row.annual)}.\n` +
          '  Rounding a small amount is the usual cause: the charm ending moves a two figure ' +
          'price further, in relative terms, than it moves a four figure one.',
      );
      process.exit(1);
    }
  }

  for (const row of rows) {
    if (row.skipped) {
      console.log(`  ${row.region}  ${row.market.padEnd(22)} ${row.skipped}`);
      continue;
    }
    console.log(
      `  ${row.region}  ${row.market.padEnd(22)} x${row.factor.toFixed(2)}` +
        `${row.source === 'explicit' ? '*' : ' '} ` +
        `${row.currency} ${fromMoney(row.monthly).toFixed(2)} / ${fromMoney(row.annual).toFixed(2)}`,
    );
  }

  // Regional configs live on the base plan, so each product is patched once with the whole
  // set rather than once per country.
  //
  // `updateMask=basePlans` replaces the entire array, so the plan has to go back complete.
  // Sending only the regional configs strips the billing period and Play rejects it with
  // "Base plan does not contain a billing plan type". Rather than restate the plan here and
  // let the two scripts drift, the live one is read and the prices are laid over it:
  // push-subscriptions.js stays the only place that decides what a base plan *is*.
  for (const product of PRODUCTS) {
    const regionalConfigs = priced.map((row) => ({
      regionCode: row.region,
      newSubscriberAvailability: true,
      price: product.term === 'annual' ? row.annual : row.monthly,
    }));

    const live = await api.get(`/applications/${api.package}/subscriptions/${product.productId}`);
    const livePlan = (live?.basePlans ?? []).find((b) => b.basePlanId === product.playBasePlanId);
    if (!livePlan) {
      throw new Error(
        `${product.productId} has no base plan ${product.playBasePlanId} on Play. ` +
          'Run `store-kit play subscriptions` first.',
      );
    }

    await api.patch(
      `/applications/${api.package}/subscriptions/${product.productId}` +
        `?updateMask=basePlans&allowMissing=false&regionsVersion.version=${encodeURIComponent(regionsVersion)}`,
      {
        packageName: api.package,
        productId: product.productId,
        basePlans: [
          {
            ...livePlan,
            regionalConfigs,
            otherRegionsConfig: {
              usdPrice: otherRegions[product.term].usdPrice,
              eurPrice: otherRegions[product.term].eurPrice,
              newSubscriberAvailability: true,
            },
          },
        ],
      },
    );
    console.log(`\n  ${product.productId}: ${regionalConfigs.length} regional price(s)`);
  }

  console.log(
    DRY_RUN
      ? '\nDry run. Nothing was written.'
      : `\nDone. ${priced.length} region(s) priced on both products.`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
