# store-kit

Push App Store Connect and Google Play listings, subscriptions and per-territory prices from
one set of JSON files in your app repo. No Ruby, no fastlane, no dependencies.

```bash
npm i -D store-kit
npx store-kit check store
npx store-kit asc push
```

## Why this exists

`deliver` handles metadata and screenshots well and cannot set a per-territory subscription
price, which is half the job. Running two tools against one credential to cover one job is
worse than running one. Current fastlane also needs a Ruby newer than the 2.6 macOS ships,
so it is not a zero-install option either, while Node is already in every React Native repo.

## What it does

| | App Store Connect | Google Play |
|---|---|---|
| listing copy, per locale | `asc metadata` | `play listing` |
| screenshots and artwork | `asc screenshots` | `play images` |
| subscriptions and localizations | `asc subscriptions` | `play subscriptions` |
| per-territory prices | `asc pricing` | `play pricing` |
| read everything back and diff | `asc verify` | `play verify` |
| what the credential can see | `asc whoami` | `play whoami` |
| submit for review | `asc submit` | |

`store-kit check store` validates the copy against both stores' field limits before you push
it, counting characters over code points rather than UTF-16 units so an emoji does not make
a valid Turkish subtitle look two characters too long. `store-kit check prices` reads both
stores and puts what Apple and Google actually charge side by side.

Every push command takes `--dry-run`, which plans every write and sends none.

## The one file

Everything comes from `store/metadata.json`. `store-kit init` scaffolds one.

Any top level key carrying a `name` is a locale, so adding a language means adding a block:

```json
{
  "shared": { "bundleId": "com.example.app", "androidPackage": "com.example.app" },
  "play": { "locales": { "en-US": "en-US", "tr": "tr-TR" } },

  "en-US": {
    "name": "Example: Does The Thing",
    "subtitle": "…", "keywords": "…", "description": "…", "whatsNew": "…",
    "play": { "shortDescription": "…" }
  },

  "inAppPurchases": {
    "trialOffer": { "days": 7 },
    "products": [
      { "productId": "example_premium_annual", "term": "annual", "priceUSD": 59.99 }
    ]
  }
}
```

`term` drives the rest. A Play base plan id defaults to `<term>-autorenew` and its period to
`P1Y` or `P1M`, so an app that names its plans conventionally writes nothing; an app that
does not sets `play.basePlanId` explicitly. This matters more than it looks, because
**RevenueCat identifies a Play subscription as `productId:basePlanId`**, so renaming one
silently unbinds the product there.

Per-territory prices live in `store/pricing.json`, as a factor on the price the store would
have charged on its own rather than on the dollar amount. Apple's and Google's own
conversions are close to an exchange rate plus local tax, which lands at the same number of
dollars everywhere and therefore at wildly different shares of local income. The scripts
read the store's conversion, multiply, and pick the nearest real price point at or below the
result, so currency, rounding and tax stay the store's problem. That is the only version of
this that stays correct when rates move.

## Credentials

Read from the app repo's `.env` or the environment, never from this package and never from a
tracked file. They are account-wide: whoever holds them can edit metadata, prices and
agreements for every app on the team.

```
ASC_KEY_ID=            # Users and Access > Integrations
ASC_ISSUER_ID=
ASC_PRIVATE_KEY_PATH=  # the .p8, or ASC_PRIVATE_KEY for its contents

PLAY_SERVICE_ACCOUNT_KEY_PATH=   # service account JSON from Google Cloud
```

## Which repo it acts on

The nearest parent directory with `store/metadata.json`, found by walking up from the working
directory the way git finds `.git`. `--root <path>` or `STORE_KIT_ROOT` overrides it, and a
wrong path fails rather than falling back to discovery, because a silent fallback pushes one
app's metadata into another.

## Notes from production

Things that cost a day each to find, kept here so they cost nobody else one.

- **Name and subtitle are not versioned.** They live on App Info, which has its own review
  state; description, keywords and What's New live on the version. Two different objects,
  two different edit windows.
- **Metadata stays editable in `WAITING_FOR_REVIEW`.** You do not have to pull a submission
  to fix a typo in the release notes.
- **A subscription price cannot be set twice without a date.** Once the subscription is
  approved, a price POST with no `startDate` is rejected with "Initial price cannot be
  created again". A `startDate` makes it a scheduled change and it goes through.
- **Play sells nothing in a region with no config and no `otherRegionsConfig`.** Apple keeps
  the base price for territories a pricing file does not name; Play does not. Missing that
  once made a product live across most of a pricing file and unsellable in the
  United States.
- **Both stores return a bare 500 now and then.** Reads are retried five times with jittered
  backoff, writes never, because a POST that got a 500 may already have been applied.
- **ASC signatures must be raw `r||s`, not DER.** `dsaEncoding: 'ieee-p1363'`. Google's are
  RSA and must not carry that flag. Both failure modes are a flat 401 or 400 with no hint.
