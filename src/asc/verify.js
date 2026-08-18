#!/usr/bin/env node
'use strict';

/**
 * Reads the listing back out of App Store Connect and checks it against the repo.
 *
 *   node scripts/asc/verify.js
 *
 * A push that reports success has proved that Apple accepted the requests, which is not the
 * same as the listing being right. Localizations can be created and left holding the
 * primary language's defaulted text, a price can land on a neighbouring point, and a
 * territory can silently have no price at all. This reads the live state and compares it to
 * store/metadata.json and store/pricing.json field by field.
 *
 * Prices are read through `included` rather than by matching ids against a separately
 * fetched list of price points. The separate fetch is paginated, so a point that happens to
 * be on another page produces no match, and the check then reports a price that was never
 * set. That is worse than no check.
 */

const path = require('node:path');

const { AppStoreConnect } = require('./api');
const {
  ROOT,
  metadata,
  resolveApp,
  resolveAppInfo,
  resolveVersion,
  resolveSubscriptions,
} = require('./context');

const pricing = require(path.join(ROOT, 'store', 'pricing.json'));

const problems = [];
const note = (message) => problems.push(message);
const money = (value) => Number.parseFloat(value);

async function main() {
  const client = new AppStoreConnect();

  const app = await resolveApp(client);
  const info = await resolveAppInfo(client, app.id);
  const version = await resolveVersion(client, app.id);

  const locales = Object.keys(metadata).filter(
    (key) => !key.startsWith('_') && metadata[key].name !== undefined,
  );

  // --- listing text --------------------------------------------------------------------

  const infoLocalizations = new Map(
    (await client.list(`/v1/appInfos/${info.id}/appInfoLocalizations`)).map((l) => [
      l.attributes.locale,
      l.attributes,
    ]),
  );
  const versionLocalizations = new Map(
    (await client.list(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).map(
      (l) => [l.attributes.locale, l.attributes],
    ),
  );

  for (const locale of locales) {
    const want = metadata[locale];
    const live = infoLocalizations.get(locale);
    const liveVersion = versionLocalizations.get(locale);

    if (!live) {
      note(`${locale}: no App Info localization`);
    } else {
      if (live.name !== want.name) note(`${locale}: name is "${live.name}", expected "${want.name}"`);
      if (live.subtitle !== want.subtitle) {
        note(`${locale}: subtitle is "${live.subtitle}", expected "${want.subtitle}"`);
      }
    }

    if (!liveVersion) {
      note(`${locale}: no version localization`);
      continue;
    }
    for (const field of ['description', 'keywords', 'promotionalText']) {
      if (liveVersion[field] !== want[field]) {
        note(`${locale}: ${field} does not match store/metadata.json`);
      }
    }
  }

  // --- subscriptions -------------------------------------------------------------------

  const { group, subscriptions } = await resolveSubscriptions(client, app.id);

  const groupLocalizations = new Map(
    (await client.list(`/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations`)).map(
      (l) => [l.attributes.locale, l.attributes.name],
    ),
  );
  for (const [locale, name] of Object.entries(
    metadata.inAppPurchases.subscriptionGroupLocalizations,
  )) {
    const live = groupLocalizations.get(locale);
    if (live !== name) note(`group ${locale}: name is "${live}", expected "${name}"`);
  }

  const livePrices = new Map();

  for (const subscription of subscriptions) {
    const productId = subscription.attributes.productId;

    const localizations = new Map(
      (await client.list(`/v1/subscriptions/${subscription.id}/subscriptionLocalizations`)).map(
        (l) => [l.attributes.locale, l.attributes],
      ),
    );
    for (const [locale, text] of Object.entries(subscription.local.localizations)) {
      const live = localizations.get(locale);
      if (!live) {
        note(`${productId} ${locale}: missing`);
      } else if (live.name !== text.displayName || live.description !== text.description) {
        note(`${productId} ${locale}: name or description does not match`);
      }
    }

    const { data, included } = await client.listFull(
      `/v1/subscriptions/${subscription.id}/prices?include=territory,subscriptionPricePoint&limit=200`,
    );
    const points = new Map(included.filter((i) => i.type === 'subscriptionPricePoints').map((i) => [i.id, i]));

    const byTerritory = new Map();
    for (const price of data) {
      const territory = price.relationships?.territory?.data?.id;
      const point = points.get(price.relationships?.subscriptionPricePoint?.data?.id);
      if (territory && point) byTerritory.set(territory, money(point.attributes.customerPrice));
    }
    livePrices.set(productId, byTerritory);

    for (const territory of Object.keys(pricing.territories)) {
      if (!byTerritory.has(territory)) {
        note(`${productId}: no price in ${territory} (${pricing.territories[territory].market})`);
      }
    }
  }

  // --- the relationship between the two plans ------------------------------------------

  const monthly = [...livePrices.entries()].find(([id]) => /month/i.test(id))?.[1];
  const annual = [...livePrices.entries()].find(([id]) => /annual|year/i.test(id))?.[1];
  const { min, max } = pricing.invariants.annualShareOfTwelveMonthly;

  if (monthly && annual) {
    for (const territory of Object.keys(pricing.territories)) {
      const m = monthly.get(territory);
      const a = annual.get(territory);
      if (m === undefined || a === undefined) continue;
      const share = a / (m * 12);
      if (share < min || share > max) {
        note(
          `${territory} (${pricing.territories[territory].market}): annual is ` +
            `${(share * 100).toFixed(0)}% of twelve monthly payments (${a} vs ${m} x 12)`,
        );
      }
    }
  }

  // --- report ---------------------------------------------------------------------------

  if (problems.length > 0) {
    console.error(`Verification found ${problems.length} problem(s):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `Verified against App Store Connect:\n` +
      `  ${locales.length} localizations, name subtitle description keywords promotional text\n` +
      `  ${subscriptions.length} products, ${Object.keys(metadata.inAppPurchases.subscriptionGroupLocalizations).length} group names, all localized\n` +
      `  ${Object.keys(pricing.territories).length} territories priced on both plans\n` +
      `  annual within ${min * 100}-${max * 100}% of twelve monthly payments everywhere`,
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
