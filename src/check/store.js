#!/usr/bin/env node
'use strict';

/**
 * Validates store/metadata.json against App Store Connect's field limits.
 *
 * ASC silently truncates nothing: it refuses the save and shows a red field, which is a
 * slow way to discover that a Turkish subtitle is two characters too long after you have
 * already pasted six other fields. Checking here means the paste is a paste.
 *
 * Character counting is deliberately done over Array.from rather than `.length`, because
 * `.length` counts UTF-16 code units. Arabic sits inside the BMP so the two agree today,
 * but an emoji in a promotional text would make `.length` overcount and reject copy that
 * Apple would have accepted.
 */

const path = require('node:path');

const metadata = require(require('../lib/root').inRoot('store', 'metadata.json'));

const LIMITS = {
  name: 30,
  subtitle: 30,
  promotionalText: 170,
  keywords: 100,
  description: 4000,
  whatsNew: 4000,
};

const IAP_LIMITS = { displayName: 30, description: 45 };

/** Google Play's own field limits. `title` and `fullDescription` reuse the ASC copy. */
const PLAY_LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };

const problems = [];
const note = (message) => problems.push(message);
const len = (value) => Array.from(value).length;

const locales = Object.keys(metadata).filter(
  (key) => !key.startsWith('_') && metadata[key].name !== undefined,
);

if (locales.length === 0) note('no locale blocks found');

for (const locale of locales) {
  const block = metadata[locale];

  for (const [field, limit] of Object.entries(LIMITS)) {
    const value = block[field];
    if (value === undefined) {
      note(`[${locale}] missing ${field}`);
      continue;
    }
    const count = len(value);
    if (count > limit) note(`[${locale}] ${field} is ${count} chars, limit ${limit}`);
    if (count === 0) note(`[${locale}] ${field} is empty`);
  }

  // Keywords are one comma-separated string. Apple counts the separators too, so spaces
  // after commas are pure waste, and a duplicate of a word already in the name or subtitle
  // buys nothing because those fields are indexed anyway.
  if (typeof block.keywords === 'string') {
    if (/,\s/.test(block.keywords)) {
      note(`[${locale}] keywords contain a space after a comma, which wastes the budget`);
    }
    const words = block.keywords.split(',').map((w) => w.trim().toLowerCase());
    const duplicates = words.filter((w, i) => words.indexOf(w) !== i);
    if (duplicates.length > 0) {
      note(`[${locale}] duplicate keyword(s): ${[...new Set(duplicates)].join(', ')}`);
    }
    const titleWords = new Set(
      `${block.name} ${block.subtitle}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
    );
    const redundant = words.filter((w) => titleWords.has(w));
    if (redundant.length > 0) {
      note(`[${locale}] keyword(s) already in name or subtitle: ${redundant.join(', ')}`);
    }
  }
}

// Apple checks app name uniqueness per storefront, and it only tells you at write time.
// Two localizations sharing a string is the one case we can catch here for free, and it is
// also the likeliest one: the natural translation of "Companions" collides across Spanish,
// Portuguese and Italian, and between the two Spanish storefronts especially.
{
  const byName = new Map();
  for (const locale of locales) {
    const name = metadata[locale].name;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(locale);
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) note(`app name "${name}" is used by ${owners.join(' and ')}`);
  }
}

// The same house style the content checker enforces on the app's own copy. Store copy is
// read by more people than any screen in the app, so exempting it would be backwards.
for (const locale of locales) {
  const block = metadata[locale];
  for (const [field] of Object.entries(LIMITS)) {
    for (const [char, name] of [['—', 'em dash'], ['–', 'en dash']]) {
      const count = String(block[field] ?? '').split(char).length - 1;
      if (count > 0) note(`[${locale}] ${field} contains ${count} ${name}(s)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Google Play. Three fields, and only one of them is new copy.
//
// `title` is the ASC name unchanged and `fullDescription` is the ASC description unchanged,
// so both are already covered by the limits above, which happen to be the same numbers.
// `shortDescription` has no App Store counterpart: it is not the 30 character subtitle and
// not the 170 character promotional text, and at 80 characters it needs its own check.
// ---------------------------------------------------------------------------
{
  const play = metadata.play;
  if (!play) {
    note('no play block in metadata.json, so nothing can be pushed to Google Play');
  } else {
    for (const locale of locales) {
      const text = metadata[locale].play?.shortDescription;
      if (text === undefined) {
        note(`[${locale}] missing play.shortDescription`);
        continue;
      }
      const count = len(text);
      if (count === 0) note(`[${locale}] play.shortDescription is empty`);
      else if (count > PLAY_LIMITS.shortDescription) {
        note(
          `[${locale}] play.shortDescription is ${count} chars, limit ` +
            `${PLAY_LIMITS.shortDescription}`,
        );
      }
      for (const [char, name] of [['—', 'em dash'], ['–', 'en dash']]) {
        const dashes = text.split(char).length - 1;
        if (dashes > 0) note(`[${locale}] play.shortDescription contains ${dashes} ${name}(s)`);
      }
    }

    // A locale with no Play code cannot be pushed and a duplicate would have two ASC
    // localizations writing over each other's listing. Both are silent at push time: the
    // API takes whatever locale it is given and the second write simply wins.
    const seen = new Map();
    for (const locale of locales) {
      const playLocale = play.locales?.[locale];
      if (!playLocale) {
        note(`[${locale}] has no Play locale in play.locales`);
        continue;
      }
      if (seen.has(playLocale)) {
        note(`play locale "${playLocale}" is claimed by both ${seen.get(playLocale)} and ${locale}`);
      }
      seen.set(playLocale, locale);
    }

    for (const field of ['defaultLanguage', 'contactEmail', 'contactWebsite', 'category']) {
      if (!play[field]) note(`play.${field} is missing`);
    }
    if (play.defaultLanguage && !play.locales?.[play.defaultLanguage]) {
      note(`play.defaultLanguage "${play.defaultLanguage}" is not one of the mapped locales`);
    }
  }
}

for (const product of metadata.inAppPurchases?.products ?? []) {
  for (const [locale, text] of Object.entries(product.localizations)) {
    for (const [field, limit] of Object.entries(IAP_LIMITS)) {
      const count = len(text[field] ?? '');
      if (count === 0) note(`[iap ${product.productId} ${locale}] missing ${field}`);
      else if (count > limit) {
        note(`[iap ${product.productId} ${locale}] ${field} is ${count} chars, limit ${limit}`);
      }
    }
  }
}

// The group display name is what a subscriber sees in iOS Settings when they go looking for
// the thing to cancel. An empty or over-long one is not caught anywhere else.
for (const [locale, name] of Object.entries(
  metadata.inAppPurchases?.subscriptionGroupLocalizations ?? {},
)) {
  const count = len(name);
  if (count === 0) note(`[group ${locale}] missing display name`);
  else if (count > 30) note(`[group ${locale}] display name is ${count} chars, limit 30`);
}

// The listing promises a free trial in four languages. If the products lose their
// introductory offer the copy becomes a lie, which is a refund request and a 1 star review.
for (const product of metadata.inAppPurchases?.products ?? []) {
  if (!/free trial/i.test(product.introductoryOffer ?? '')) {
    note(`[iap ${product.productId}] no free trial recorded, but the listing copy promises one`);
  }
}

if (problems.length > 0) {
  console.error(`Store metadata check failed with ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`Store metadata OK — ${locales.length} locales (${locales.join(', ')}).`);
for (const locale of locales) {
  const b = metadata[locale];
  console.log(
    `  ${locale.padEnd(6)} name ${String(len(b.name)).padStart(2)}/30  ` +
      `subtitle ${String(len(b.subtitle)).padStart(2)}/30  ` +
      `keywords ${String(len(b.keywords)).padStart(3)}/100  ` +
      `promo ${String(len(b.promotionalText)).padStart(3)}/170  ` +
      `desc ${String(len(b.description)).padStart(4)}/4000  ` +
      `play ${String(len(b.play?.shortDescription ?? '')).padStart(2)}/80 ` +
      `-> ${metadata.play?.locales?.[locale] ?? '?'}`,
  );
}
