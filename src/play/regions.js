'use strict';

/**
 * Territory codes, Apple's to Google's.
 *
 * `store/pricing.json` is written in ISO 3166-1 alpha-3 because that is what App Store
 * Connect uses. Play uses alpha-2. The file stays as it is rather than growing a second set
 * of keys: it is the source of truth for a pricing decision, not for either store's spelling
 * of a country, and duplicating the list is how the two drift.
 *
 * Unknown codes throw rather than being skipped. A silent skip would leave that territory on
 * Google's automatic conversion, which is the very thing the price level factors exist to
 * override, and nothing downstream would report it.
 */

const ALPHA3_TO_ALPHA2 = {
  ALB: 'AL', ARE: 'AE', ARG: 'AR', AZE: 'AZ', BGR: 'BG', BHR: 'BH', BIH: 'BA', BRA: 'BR',
  BRN: 'BN', CHL: 'CL', CHN: 'CN', COL: 'CO', CZE: 'CZ', DZA: 'DZ', EGY: 'EG', ESP: 'ES',
  GHA: 'GH', GRC: 'GR', HKG: 'HK', HRV: 'HR', HUN: 'HU', IDN: 'ID', IND: 'IN', IRQ: 'IQ',
  ITA: 'IT', JOR: 'JO', JPN: 'JP', KAZ: 'KZ', KEN: 'KE', KGZ: 'KG', KOR: 'KR', KWT: 'KW',
  LBN: 'LB', LKA: 'LK', MAR: 'MA', MEX: 'MX', MKD: 'MK', MYS: 'MY', NGA: 'NG', NPL: 'NP',
  OMN: 'OM', PAK: 'PK', PER: 'PE', PHL: 'PH', POL: 'PL', PRT: 'PT', QAT: 'QA', ROU: 'RO',
  RUS: 'RU', SAU: 'SA', SEN: 'SN', SRB: 'RS', SVK: 'SK', THA: 'TH', TUN: 'TN', TUR: 'TR',
  TWN: 'TW', TZA: 'TZ', UKR: 'UA', USA: 'US', UZB: 'UZ', VNM: 'VN', YEM: 'YE', ZAF: 'ZA',
};

function toPlayRegion(alpha3) {
  const alpha2 = ALPHA3_TO_ALPHA2[alpha3];
  if (!alpha2) {
    throw new Error(
      `No Play region code for "${alpha3}". Add it to scripts/play/regions.js rather than ` +
        'letting the territory fall back to Google\'s automatic price.',
    );
  }
  return alpha2;
}

/**
 * Currencies Play quotes in whole units.
 *
 * Rounding a price to `.99` in a zero-decimal currency produces something the API will take
 * and the store will render as a fraction of a yen. The list is the intersection of ISO 4217
 * zero-decimal currencies with the territories `pricing.json` actually names.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'XOF', 'XAF']);

/**
 * Rounds a target amount to something a store would print.
 *
 * Apple has a fixed ladder of price points and the ASC script snaps to the nearest rung at or
 * below the target. Play takes arbitrary micros, which sounds easier and is worse: nothing
 * stops you shipping 3.47 EUR, and a price nobody would have chosen reads as a bug. So the
 * rounding is done here instead, to the charm price the ladder would have landed on.
 */
function roundPrice(amount, currency) {
  if (ZERO_DECIMAL.has(currency)) {
    // Round to a readable step rather than to the unit: 1290 JPY, not 1287.
    const step = amount >= 1000 ? 100 : 10;
    return Math.max(step, Math.round(amount / step) * step);
  }

  // The nearest charm price, not the next one down. Snapping down unconditionally is what
  // Apple's ladder effectively does, and it is fine there because the rungs are close
  // together, but here it can cost most of a unit. On a 1.40 target that is a 29 percent cut,
  // and two of those compounding is what pushes an annual price outside the ratio the whole
  // pricing file is built around.
  const lower = Math.floor(amount) - 0.01;
  const upper = Math.floor(amount) + 0.99;
  const nearest = amount - lower <= upper - amount ? lower : upper;
  // Nothing below 0.99: a charm price under a unit reads as broken rather than as cheap, and
  // pricing.json has its own floor in dollars for the same reason.
  return Math.max(0.99, Math.round(nearest * 100) / 100);
}

/** Play money is `{ currencyCode, units, nanos }`. Nanos are the fractional part, 1e-9. */
function toMoney(amount, currency) {
  const rounded = roundPrice(amount, currency);
  const units = Math.floor(rounded);
  const nanos = Math.round((rounded - units) * 1e9);
  return { currencyCode: currency, units: String(units), nanos };
}

function fromMoney(money) {
  return Number(money.units ?? 0) + Number(money.nanos ?? 0) / 1e9;
}

/**
 * The regions catalogue Play wants writes stamped against, e.g. "2025/03".
 *
 * Every subscription create and patch is rejected with "Regions Version must be specified"
 * without it, because Google's list of sellable countries changes and it wants to know which
 * revision a price list was built for. Read from the API rather than hardcoded: a pinned
 * string keeps working right up until Google publishes a new revision, and then fails on a
 * day nobody touched this file.
 *
 * Comes back from `pricing:convertRegionPrices` under `regionVersion`, singular, while the
 * write side asks for `regionsVersion`, plural. That is Google's spelling, not a typo here.
 */
/**
 * Google's own conversion of a dollar amount into every region it sells in.
 *
 * A POST that computes rather than writes, so the dry-run guard has to be lifted for it or
 * the caller is handed the guard's stub and builds a price list out of nothing. That was not
 * hypothetical: two of the three call sites lifted it and one did not, so `--dry-run` died
 * every single time, first on "Play did not return a regionVersion" and then, once that was
 * fixed, on "Play returned no convertedOtherRegionsPrice". The one mode whose entire job is
 * to be safe to run was the only mode that could not run. Lifting it in one place is what
 * stops the next call site from getting it wrong too.
 *
 * Google stores nothing from this call.
 */
async function convertRegionPrices(api, amountUSD) {
  const price = toMoney(amountUSD, 'USD');
  const wasDry = api.dryRun;
  api.dryRun = false;
  try {
    return await api.post(`/applications/${api.package}/pricing:convertRegionPrices`, {
      price: { currencyCode: 'USD', units: price.units, nanos: price.nanos },
    });
  } finally {
    api.dryRun = wasDry;
  }
}

async function currentRegionsVersion(api) {
  const probe = await convertRegionPrices(api, 1);
  const version = probe?.regionVersion?.version;
  if (!version) throw new Error('Play did not return a regionVersion to stamp writes with.');
  return version;
}

module.exports = {
  ALPHA3_TO_ALPHA2,
  toPlayRegion,
  roundPrice,
  toMoney,
  fromMoney,
  ZERO_DECIMAL,
  convertRegionPrices,
  currentRegionsVersion,
};
