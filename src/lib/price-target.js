'use strict';

/**
 * What a territory should pay per month, decided in one place for both stores.
 *
 * This file exists because the decision had already diverged. The two push scripts each read
 * the same `factor` out of store/pricing.json and each multiplied it by its own store's
 * conversion of the base price, which sounds identical and is not. The two stores do not
 * convert a dollar amount into local currency alike, and in a soft currency they can sit more
 * than ten percent apart. Same file, same factor, and Android users were charged noticeably
 * more than iPhone users for the same product in the same country; elsewhere the gap ran the
 * other way, and in one market it approached a factor of two.
 *
 * So the target is computed here, from the store's own converted price, and the two callers
 * are left with only the part that genuinely differs: Apple snapping to a rung on its price
 * point ladder, Play rounding to a charm price. The stores still land a few percent apart
 * where a ladder is coarse. They no longer land fifteen percent apart because two scripts
 * quietly disagreed about what the price was meant to be.
 */

/**
 * @param {{ factor?: number, price?: { currency: string, monthly: number }, market: string }} entry
 * @param {{ autoPrice: number, currency: string, pricing: object, territory: string }} context
 * @returns {{ target: number, source: 'explicit' | 'factor' }}
 */
function monthlyTarget(entry, { autoPrice, currency, pricing, territory }) {
  // An explicit price wins over everything below it, floor included.
  //
  // The floor guards a number nobody chose: a factor times a conversion can land anywhere,
  // and clamping it is how a rounding accident stops becoming a live price. An explicit
  // price is the opposite, a decision someone made about a specific market, and silently
  // raising it to a floor would be the script overruling the person who wrote the file.
  // A market priced by hand against what people there already pay for a comparable
  // subscription is exactly that case, and such a price can legitimately sit under the floor.
  if (entry.price) {
    if (entry.price.currency !== currency) {
      throw new Error(
        `${territory} (${entry.market}) has an explicit price in ${entry.price.currency}, but ` +
          `this store sells there in ${currency}. Storefront currencies change; update ` +
          'store/pricing.json rather than letting the amount be reinterpreted as the new one.',
      );
    }
    return { target: entry.price.monthly, source: 'explicit' };
  }

  if (typeof entry.factor !== 'number') {
    throw new Error(`${territory} (${entry.market}) has neither a factor nor an explicit price.`);
  }

  // Capped at 1.00: a few territories index above the United States and could bear more, but
  // charging them more for the same app is a different decision from the one this file makes.
  const factor = Math.min(1, entry.factor);

  // The floor is written in dollars, so it has to be converted before it can be compared with
  // a local amount. The ratio between the store's converted price and the dollar base is the
  // rate that store used, which is the only rate that can be right here.
  const rate = autoPrice / pricing.base.monthlyUSD;
  const floor = pricing.minimumMonthlyUSD * rate;

  return { target: Math.max(autoPrice * factor, floor), source: 'factor' };
}

module.exports = { monthlyTarget };
