#!/usr/bin/env node
'use strict';

/**
 * Reads both stores back and reports where they disagree about the same country.
 *
 *   node scripts/check-prices.js
 *   node scripts/check-prices.js --all      list every territory, not just the divergent ones
 *
 * The check that was missing, and it is the same shape as the one in check-captures.js. Each
 * store had a verify script that read its own listing back and confirmed it matched
 * store/pricing.json. Both passed. Neither could see the other, so nothing in the repo was
 * ever in a position to notice that the same country was charged one price on the App Store
 * and a materially different one on Google Play, in either direction depending on the market.
 * One pricing file, one factor per country, two prices.
 *
 * The cause was not a typo. Each push script multiplied the factor by its own store's
 * conversion of the base price, and the two stores do not convert alike. lib/price-target.js
 * now decides the target once for both, which removes the mechanism, and this removes the
 * blind spot, because a shared decision that nobody reads back is still a claim rather than
 * a fact.
 *
 * A gap of a few percent is expected and is not reported: Apple picks from a fixed ladder of
 * price points and Play takes any amount, so a coarse ladder moves the two apart on its own.
 */

const path = require('node:path');

const { AppStoreConnect } = require('../asc/api');
const { resolveApp, resolveSubscriptions } = require('../asc/context');
const { PlayApi } = require('../play/api');
const { toPlayRegion, fromMoney } = require('../play/regions');

const ROOT = require('../lib/root').root();
const pricing = require(path.join(ROOT, 'store', 'pricing.json'));
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));

const argv = process.argv.slice(2);
const SHOW_ALL = argv.includes('--all');

/**
 * How far apart the two stores may sit before it is a problem.
 *
 * Apple's ladder is the reason this is not zero. Google takes an arbitrary amount in local
 * currency; Apple takes the nearest rung of a fixed ladder at or below it. In a currency
 * whose ladder is sparse, that rounding alone puts the two stores a few percent apart with
 * nobody having done anything wrong, and the widest such gap observed in practice was
 * around four percent. The threshold sits above that, and far enough below a real mistake
 * that a price typed into one console and not the other still trips it.
 */
const TOLERANCE_PCT = 8;

const money = (value) => Number.parseFloat(value);

async function applePrices() {
  const client = new AppStoreConnect({});
  const app = await resolveApp(client);
  const { subscriptions } = await resolveSubscriptions(client, app.id);

  const currencyOf = new Map(
    (await client.list('/v1/territories?limit=200')).map((t) => [t.id, t.attributes.currency]),
  );

  const out = new Map();
  const codes = Object.keys(pricing.territories);

  for (const subscription of subscriptions) {
    const term = /year|annual/i.test(subscription.local.duration) ? 'annual' : 'monthly';

    for (let i = 0; i < codes.length; i += 20) {
      const chunk = codes.slice(i, i + 20);
      const page = await client.listFull(
        `/v1/subscriptions/${subscription.id}/prices` +
          `?filter[territory]=${chunk.join(',')}&include=subscriptionPricePoint,territory&limit=200`,
      );
      const points = new Map(
        page.included
          .filter((item) => item.type === 'subscriptionPricePoints')
          .map((item) => [item.id, item.attributes]),
      );

      for (const price of page.data) {
        // A preserved entry is what an existing subscriber keeps paying, not what the store
        // is charging today. Comparing it against Play would report a difference that is
        // real for one person and wrong for everyone else.
        if (price.attributes.preserved) continue;
        const territory = price.relationships?.territory?.data?.id;
        const point = points.get(price.relationships?.subscriptionPricePoint?.data?.id);
        if (!territory || !point) continue;
        if (!out.has(territory)) out.set(territory, { currency: currencyOf.get(territory) });
        out.get(territory)[term] = money(point.customerPrice);
      }
    }
  }

  return out;
}

async function playPrices() {
  const api = new PlayApi({});
  const out = new Map();

  for (const product of metadata.inAppPurchases.products) {
    const term = /annual/i.test(product.productId) ? 'annual' : 'monthly';
    const live = await api.get(`/applications/${api.package}/subscriptions/${product.productId}`);
    for (const plan of live.basePlans ?? []) {
      for (const config of plan.regionalConfigs ?? []) {
        if (!out.has(config.regionCode)) {
          out.set(config.regionCode, { currency: config.price.currencyCode });
        }
        out.get(config.regionCode)[term] = fromMoney(config.price);
      }
    }
  }

  return out;
}

async function main() {
  const [apple, play] = await Promise.all([applePrices(), playPrices()]);

  const divergent = [];
  const incomparable = [];
  const rows = [];

  for (const [alpha3, entry] of Object.entries(pricing.territories)) {
    let alpha2;
    try {
      alpha2 = toPlayRegion(alpha3);
    } catch {
      continue;
    }

    const a = apple.get(alpha3);
    const p = play.get(alpha2);
    if (!a || !p) continue;

    // Where the two storefronts bill in different currencies there is no comparison to make
    // without an exchange rate, and inventing one here would turn a clean "cannot tell" into
    // a number that looks authoritative and moves every time the rate does.
    if (a.currency !== p.currency) {
      incomparable.push(`${alpha3} ${entry.market} (Apple ${a.currency}, Play ${p.currency})`);
      continue;
    }

    for (const term of ['monthly', 'annual']) {
      if (a[term] === undefined || p[term] === undefined) continue;
      const gap = (100 * Math.abs(a[term] - p[term])) / Math.max(a[term], p[term]);
      const bad = gap > TOLERANCE_PCT;
      if (bad) divergent.push({ alpha3, market: entry.market, term, a: a[term], p: p[term], gap });
      if (bad || SHOW_ALL) {
        rows.push(
          `  ${alpha3}  ${entry.market.padEnd(22)} ${term.padEnd(7)} ` +
            `${a.currency} ${String(a[term]).padStart(10)} vs ${String(p[term]).padStart(10)}` +
            `   ${gap.toFixed(1).padStart(5)}%${bad ? '  DIVERGENT' : ''}`,
        );
      }
    }
  }

  console.log('territory  market                 term    Apple vs Play\n');
  for (const row of rows) console.log(row);
  if (rows.length === 0) console.log('  (nothing outside tolerance)');

  if (incomparable.length > 0) {
    console.log(
      `\n${incomparable.length} territory/territories bill in different currencies on the ` +
        'two stores, so they cannot be compared here:',
    );
    for (const line of incomparable) console.log(`  ${line}`);
  }

  if (divergent.length > 0) {
    console.error(
      `\n${divergent.length} price(s) differ by more than ${TOLERANCE_PCT}% between the ` +
        'two stores. Same product, same country, two answers.',
    );
    console.error(
      'Check store/pricing.json for that territory, then re-run both push scripts with ' +
        '--dry-run before writing anything.',
    );
    process.exit(1);
  }

  console.log(`\nBoth stores agree within ${TOLERANCE_PCT}% everywhere they are comparable.`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
