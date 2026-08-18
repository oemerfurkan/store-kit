'use strict';

/**
 * The contract between this package and an app repo.
 *
 * Everything the commands need comes from `store/metadata.json` and `store/pricing.json`.
 * This module is the only place that knows their shape, so a field that moves has one
 * call site to change rather than fourteen.
 *
 * Its second job is derivation. A Play base plan is called `annual-autorenew` in this repo
 * and could be called anything in the next one, so it is a config field; but a field that
 * every app would fill in the same way is a field every app will eventually get wrong, so
 * anything derivable is derived and the explicit value only overrides it. `products` below
 * is the whole of that idea: an app that names its base plans conventionally writes nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

const { root, inRoot } = require('./root');

let cache = null;

function readJson(file, what) {
  if (!fs.existsSync(file)) {
    throw new Error(`${what} not found at ${file}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

/** Expo's app.json, when there is one. Optional: a bare metadata repo is a valid consumer. */
function appJson() {
  const file = inRoot('app.json');
  if (!fs.existsSync(file)) return null;
  return readJson(file, 'app.json');
}

/**
 * Term for a product, in the one vocabulary the rest of the package uses.
 *
 * Three sources in order of trust: the explicit field, an ISO 8601 period, then the human
 * `duration` string that this repo's metadata has always carried. The last one is a
 * fallback rather than the interface, because "1 month" is prose and prose drifts.
 */
function termOf(product) {
  if (product.term) return product.term;

  const period = product.play?.period ?? product.period;
  if (period === 'P1M') return 'monthly';
  if (period === 'P1Y') return 'annual';
  if (period === 'P1W') return 'weekly';

  const duration = String(product.duration ?? '').toLowerCase();
  if (duration.includes('year') || duration.includes('annual')) return 'annual';
  if (duration.includes('month')) return 'monthly';
  if (duration.includes('week')) return 'weekly';

  throw new Error(
    `Product ${product.productId} has no term. Add "term": "monthly" | "annual" | "weekly" ` +
      'to it in store/metadata.json.',
  );
}

const PERIOD_FOR = { weekly: 'P1W', monthly: 'P1M', annual: 'P1Y' };

/**
 * Products, normalised.
 *
 * Every consumer gets `term`, `playBasePlanId` and `playPeriod` whether or not the repo
 * spelled them out, which is what let the two hardcoded BASE_PLANS tables die.
 */
function products(metadata) {
  const raw = metadata.inAppPurchases?.products ?? [];
  if (raw.length === 0) {
    throw new Error('store/metadata.json has no inAppPurchases.products.');
  }

  return raw.map((product) => {
    if (!product.productId) throw new Error('A product in store/metadata.json has no productId.');
    const term = termOf(product);
    return {
      ...product,
      term,
      playBasePlanId: product.play?.basePlanId ?? `${term}-autorenew`,
      playPeriod: product.play?.period ?? PERIOD_FOR[term],
    };
  });
}

/**
 * The free trial, if the app sells one.
 *
 * `introductoryOffer` has always been prose in this repo's metadata and is checked by the
 * store validator, so it stays the source of truth for *whether* there is a trial. How long
 * it runs is read out of that prose only as a fallback: an app that means fourteen days
 * should say so in a field rather than trust a regex to find the number.
 */
function trialOffer(metadata) {
  const explicit = metadata.inAppPurchases?.trialOffer;
  if (explicit) {
    const days = explicit.days ?? 7;
    return {
      offerId: explicit.offerId ?? `free-trial-${days}d`,
      days,
      period: explicit.period ?? `P${days}D`,
    };
  }

  const prose = metadata.inAppPurchases?.products?.find((p) => /free trial/i.test(p.introductoryOffer ?? ''));
  if (!prose) return null;

  const days = Number(/(\d+)\s*day/i.exec(prose.introductoryOffer)?.[1] ?? 7);
  return { offerId: `free-trial-${days}d`, days, period: `P${days}D` };
}

function load() {
  if (cache) return cache;

  const metadata = readJson(inRoot('store', 'metadata.json'), 'store/metadata.json');
  const pricingFile = inRoot('store', 'pricing.json');
  const pricing = fs.existsSync(pricingFile) ? readJson(pricingFile, 'store/pricing.json') : null;
  const app = appJson();
  const shared = metadata.shared ?? {};

  const bundleId = shared.bundleId ?? app?.expo?.ios?.bundleIdentifier ?? null;
  const androidPackage = shared.androidPackage ?? app?.expo?.android?.package ?? null;

  cache = {
    root: root(),
    metadata,
    pricing,
    app,
    shared,

    /** iOS. `bundleId` is how every ASC object is found, so its absence is fatal there. */
    bundleId,
    appleId: shared.appleId ?? null,

    /** Android. Same role for Play: every endpoint is scoped by package name. */
    androidPackage,

    products: products(metadata),
    trialOffer: trialOffer(metadata),

    /** ASC locale -> Play locale. Absent means the listing does not carry that language. */
    playLocale: (locale) => metadata.play?.locales?.[locale] ?? null,

    /** Locale blocks, i.e. every top level key that carries a `name`. */
    locales: () =>
      Object.keys(metadata).filter((key) => !key.startsWith('_') && metadata[key]?.name !== undefined),

    path: (...parts) => path.join(root(), ...parts),
  };

  return cache;
}

/** Throws with a specific message rather than letting a null bundle id reach a URL. */
function requireIos(config) {
  if (!config.bundleId) {
    throw new Error(
      'No iOS bundle id. Set shared.bundleId in store/metadata.json, or expo.ios.bundleIdentifier ' +
        'in app.json.',
    );
  }
  return config.bundleId;
}

function requireAndroid(config) {
  if (!config.androidPackage) {
    throw new Error(
      'No Android package name. Set shared.androidPackage in store/metadata.json, or ' +
        'expo.android.package in app.json.',
    );
  }
  return config.androidPackage;
}

module.exports = { load, requireIos, requireAndroid, readJson };
