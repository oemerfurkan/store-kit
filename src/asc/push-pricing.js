#!/usr/bin/env node
'use strict';

/**
 * Sets a purchasing-power adjusted subscription price in every territory listed in
 * store/pricing.json.
 *
 *   node scripts/asc/push-pricing.js --dry-run    print the whole table, write nothing
 *   node scripts/asc/push-pricing.js              apply it
 *
 * The interesting decision is what the factor multiplies. Multiplying the dollar amount
 * would mean doing currency conversion here, which means holding exchange rates in the
 * repo, which means being wrong within a week. Apple already publishes its own conversion
 * of the US price into every currency, called an equalization, so the factor multiplies
 * that instead. Rates, tax and rounding stay Apple's, and this file only expresses the one
 * thing Apple does not know: that the same dollar buys a different amount of someone's day
 * in Karachi than it does in Munich.
 *
 * Prices land on discrete price points rather than arbitrary numbers, so the result is the
 * nearest real point at or below the target. That rounding is also why the annual to
 * monthly ratio is checked afterwards instead of assumed: two independent roundings can
 * drift the annual plan out of being an obvious saving, and an annual plan that is not an
 * obvious saving is just a worse monthly plan.
 */

const path = require('node:path');

const { AppStoreConnect, AscError } = require('./api');
const { ROOT, resolveSubscriptions, resolveApp } = require('./context');
const { monthlyTarget } = require('../lib/price-target');

const pricing = require(path.join(ROOT, 'store', 'pricing.json'));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');

const money = (value) => Number.parseFloat(value);

/**
 * Reads price points in bulk.
 *
 * A subscription has on the order of a hundred price points per territory, and there are
 * sixty-odd territories here, so asking one territory at a time is thousands of requests
 * against an hourly budget. The filter takes a comma separated list; chunking keeps each
 * URL to a sane length while still cutting the request count by an order of magnitude.
 */
async function pricePointsByTerritory(client, subscriptionId, territories) {
  const byTerritory = new Map();

  for (let i = 0; i < territories.length; i += 10) {
    const chunk = territories.slice(i, i + 10);
    const points = await client.list(
      `/v1/subscriptions/${subscriptionId}/pricePoints` +
        `?filter[territory]=${chunk.join(',')}&include=territory&limit=200`,
    );
    for (const point of points) {
      const territory = point.relationships?.territory?.data?.id;
      if (!territory) continue;
      if (!byTerritory.has(territory)) byTerritory.set(territory, []);
      byTerritory.get(territory).push(point);
    }
  }

  for (const points of byTerritory.values()) {
    points.sort((a, b) => money(a.attributes.customerPrice) - money(b.attributes.customerPrice));
  }

  return byTerritory;
}

/**
 * What Apple would have charged in each territory, left alone.
 */
async function equalizationsOf(client, usPricePointId, territories) {
  const byTerritory = new Map();

  for (let i = 0; i < territories.length; i += 30) {
    const chunk = territories.slice(i, i + 30);
    const points = await client.list(
      `/v1/subscriptionPricePoints/${usPricePointId}/equalizations` +
        `?filter[territory]=${chunk.join(',')}&include=territory&limit=200`,
    );
    for (const point of points) {
      const territory = point.relationships?.territory?.data?.id;
      if (territory) byTerritory.set(territory, point);
    }
  }

  return byTerritory;
}

/**
 * Makes sure every product is actually sold somewhere before pricing it.
 *
 * A subscription with no availability record is available in no territory, and App Store
 * Connect reports that as MISSING_METADATA rather than as an availability problem. The
 * product then sits there looking complete, with its name, description, review screenshot,
 * price and free trial all filled in, and nothing on the page says which field is missing.
 *
 * Where two products share a group, the missing one mirrors its sibling rather than
 * defaulting to every territory. A group whose annual plan reaches more countries than its
 * monthly plan is worse than one that reaches fewer: in the gap, the only plan on offer is
 * the expensive one, and the person seeing it has no way to know a cheaper plan exists.
 */
async function ensureAvailability(client, subscriptions) {
  const existing = new Map();

  for (const subscription of subscriptions) {
    try {
      const availability = await client.get(
        `/v1/subscriptions/${subscription.id}/subscriptionAvailability`,
      );
      const territories = await client.list(
        `/v1/subscriptionAvailabilities/${availability.data.id}/availableTerritories`,
      );
      existing.set(subscription.id, territories.map((t) => t.id));
    } catch (error) {
      if (!(error instanceof AscError) || error.status !== 404) throw error;
      existing.set(subscription.id, null);
    }
  }

  const template = [...existing.values()].find((value) => value !== null);

  for (const subscription of subscriptions) {
    if (existing.get(subscription.id) !== null) continue;

    const territories =
      template ?? (await client.list('/v1/territories?limit=200')).map((t) => t.id);

    console.log(
      `  ${subscription.attributes.productId} had no availability record. ` +
        `Creating one for ${territories.length} territories` +
        `${template ? ', mirroring its sibling' : ''}.`,
    );

    await client.post('/v1/subscriptionAvailabilities', {
      data: {
        type: 'subscriptionAvailabilities',
        attributes: { availableInNewTerritories: true },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: subscription.id } },
          availableTerritories: {
            data: territories.map((id) => ({ type: 'territories', id })),
          },
        },
      },
    });
  }
}

/**
 * The nearest real price point at or below the target.
 *
 * Rounding down rather than to nearest, because the whole point of the exercise is to be
 * affordable in the territory and the gap between adjacent points widens as prices climb.
 * Falling below the cheapest available point means the target was under Apple's own floor,
 * and the cheapest point is then the honest answer.
 */
function choosePoint(points, target) {
  const affordable = points.filter((point) => money(point.attributes.customerPrice) <= target);
  return affordable.length > 0 ? affordable[affordable.length - 1] : points[0];
}

/**
 * The day the new prices take effect, as YYYY-MM-DD in UTC.
 *
 * Tomorrow rather than today: App Store Connect rejects a start date it considers already
 * past, and "today" is ambiguous across the timezone boundary between this machine and
 * Apple's servers.
 */
const SCHEDULED_START = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN, verbose: VERBOSE });

  const app = await resolveApp(client);
  const { subscriptions } = await resolveSubscriptions(client, app.id);

  const territories = Object.keys(pricing.territories);

  // Which currency each storefront actually charges in. Needed because an explicit price in
  // store/pricing.json names its currency, and that claim has to be checked rather than
  // assumed: a price point carries only an amount, so an entry written in one currency would
  // otherwise be applied verbatim as that many units of whatever the territory switched to.
  // Storefronts do change, and several sell in dollars rather than in the local currency.
  const currencyOf = new Map(
    (await client.list('/v1/territories?limit=200')).map((t) => [t.id, t.attributes.currency]),
  );

  console.log(
    `${DRY_RUN ? 'Planning' : 'Applying'} prices for ${subscriptions.length} product(s) ` +
      `across ${territories.length} territories.\n`,
  );

  await ensureAvailability(client, subscriptions);

  // Keyed by territory so the annual and monthly results can be compared once both exist.
  const chosen = new Map();

  // Monthly is priced first because annual is derived from it. Sorting on the period rather
  // than trusting the order the API returned them in: that order is not documented, and a
  // silent flip would mean the annual plan quietly falls back to its own equalization.
  const ordered = [...subscriptions].sort(
    (a, b) =>
      (/year|annual/i.test(a.local.duration) ? 1 : 0) -
      (/year|annual/i.test(b.local.duration) ? 1 : 0),
  );

  for (const subscription of ordered) {
    const productId = subscription.attributes.productId;
    const isAnnual = /year|annual/i.test(subscription.local.duration);
    const baseUSD = isAnnual ? pricing.base.annualUSD : pricing.base.monthlyUSD;

    const usPoints = await client.list(
      `/v1/subscriptions/${subscription.id}/pricePoints` +
        `?filter[territory]=${pricing.base.territory}&include=territory&limit=200`,
    );
    const basePoint = usPoints.find(
      (point) => Math.abs(money(point.attributes.customerPrice) - baseUSD) < 0.005,
    );
    if (!basePoint) {
      throw new Error(
        `${productId}: no ${pricing.base.territory} price point at ${baseUSD}. ` +
          'Check store/pricing.json against the price actually set in App Store Connect.',
      );
    }

    const equalized = await equalizationsOf(client, basePoint.id, territories);
    const available = await pricePointsByTerritory(client, subscription.id, territories);

    console.log(`${productId}  (base ${baseUSD} ${pricing.base.territory})`);
    console.log('  territory  market                    apple      ours   factor');

    for (const territory of territories) {
      const entry = pricing.territories[territory];
      const reference = equalized.get(territory);
      const points = available.get(territory);

      if (!reference || !points || points.length === 0) {
        console.log(`  ${territory}        ${entry.market.padEnd(24)}  not available in this territory`);
        continue;
      }

      const applePrice = money(reference.attributes.customerPrice);

      // The monthly price comes from scripts/price-target.js, shared with the Play script so
      // the two stores cannot quietly price the same country differently. The annual price
      // comes from the monthly price that was actually chosen, so the saving a subscriber
      // sees is the same everywhere. Pricing both from their own equalizations let two
      // roundings compound in the same direction, which is how Qatar and Romania ended up
      // offering an annual plan at 42 percent of twelve months instead of 50.
      const monthlyHere = chosen.get(territory)?.monthly;
      let target;
      let source = 'factor';
      if (isAnnual && monthlyHere !== undefined) {
        target = monthlyHere * 12 * pricing.annualDiscount;
      } else {
        ({ target, source } = monthlyTarget(entry, {
          autoPrice: applePrice,
          currency: currencyOf.get(territory),
          pricing,
          territory,
        }));
      }

      const point = choosePoint(points, target);
      const ourPrice = money(point.attributes.customerPrice);

      console.log(
        `  ${territory}        ${entry.market.padEnd(24)}` +
          `${applePrice.toFixed(2).padStart(9)}${ourPrice.toFixed(2).padStart(10)}` +
          `${(ourPrice / applePrice).toFixed(2).padStart(9)}${source === 'explicit' ? '*' : ''}`,
      );

      if (!chosen.has(territory)) chosen.set(territory, {});
      chosen.get(territory)[isAnnual ? 'annual' : 'monthly'] = ourPrice;

      await client.post('/v1/subscriptionPrices', {
        data: {
          type: 'subscriptionPrices',
          attributes: {
            // `startDate` is what makes this a scheduled price change rather than the
            // subscription's initial price, and it stopped being optional the moment the
            // subscription was approved: App Store Connect answers a dateless price with
            // "Initial price cannot be created again after subscription is approved" and a
            // 409. Before approval the same request was correct, which is why it was written
            // without one.
            startDate: SCHEDULED_START,
            // Keeps anyone who already subscribed on the terms they agreed to. Worth knowing
            // in both directions: where a price goes down, existing subscribers stay on the
            // higher one until they resubscribe. That is the right trade while the subscriber
            // count is near zero, and it is the difference between a correction and a
            // betrayal once it is not.
            preserveCurrentPrice: true,
          },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: subscription.id } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: point.id } },
            territory: { data: { type: 'territories', id: territory } },
          },
        },
      });
    }

    console.log();
  }

  // The annual plan has to stay a visible saving in every currency, not just in dollars.
  const { min, max } = pricing.invariants.annualShareOfTwelveMonthly;
  const broken = [];
  for (const [territory, prices] of chosen) {
    if (prices.monthly === undefined || prices.annual === undefined) continue;
    const share = prices.annual / (prices.monthly * 12);
    if (share < min || share > max) {
      broken.push(
        `${territory} (${pricing.territories[territory].market}): annual is ` +
          `${(share * 100).toFixed(0)}% of twelve monthly payments`,
      );
    }
  }

  if (broken.length > 0) {
    console.error(
      `\nThe annual plan drifted outside ${min * 100}-${max * 100}% of twelve monthly ` +
        `payments in ${broken.length} territory/territories:\n`,
    );
    for (const line of broken) console.error(`  - ${line}`);
    console.error('\nAdjust the factor for those territories in store/pricing.json.');
    process.exit(1);
  }

  console.log(
    DRY_RUN
      ? 'Dry run. Nothing was written. Remove --dry-run to apply.'
      : `Done. ${chosen.size} territories priced on both products.`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
