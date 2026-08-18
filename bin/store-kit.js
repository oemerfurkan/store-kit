#!/usr/bin/env node
'use strict';

/**
 * The one entry point.
 *
 * Each command is still a standalone module that runs its own `main()` on require, exactly
 * as it did when these lived in an app repo, and this dispatcher spawns it as a child
 * process rather than requiring it in. That buys three things for one line of cost: exit
 * codes propagate untouched, a sequence like `asc push` can await each step instead of
 * firing three floating promises, and a command that throws cannot leave a half-mutated
 * module cache behind for the next one in the chain.
 *
 * The app repo is found by walking up from the working directory for store/metadata.json.
 * `--root` overrides that, and is passed down as STORE_KIT_ROOT so the child agrees.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const pkg = require('../package.json');

/**
 * Commands, grouped by store. A string is a module path; an array is a sequence run in
 * order, stopping at the first failure.
 */
const COMMANDS = {
  asc: {
    whoami: 'asc/whoami.js',
    metadata: 'asc/push-metadata.js',
    subscriptions: 'asc/push-subscriptions.js',
    pricing: 'asc/push-pricing.js',
    screenshots: 'asc/push-screenshots.js',
    verify: 'asc/verify.js',
    submit: 'asc/submit.js',
    fastlane: 'asc/fastlane-export.js',
    values: 'asc/values.js',
    push: ['asc/push-metadata.js', 'asc/push-subscriptions.js', 'asc/push-pricing.js'],
  },
  play: {
    whoami: 'play/whoami.js',
    listing: 'play/push-listing.js',
    images: 'play/push-images.js',
    subscriptions: 'play/push-subscriptions.js',
    pricing: 'play/push-pricing.js',
    verify: 'play/verify.js',
    push: [
      'play/push-listing.js',
      'play/push-images.js',
      'play/push-subscriptions.js',
      'play/push-pricing.js',
    ],
  },
  check: {
    store: 'check/store.js',
    prices: 'check/prices.js',
  },
};

const USAGE = `store-kit ${pkg.version}

  store-kit <store> <command> [flags]

App Store Connect
  asc whoami            what the credential can see: app, version, build, subscriptions
  asc metadata          name, subtitle, keywords, description, What's New, per locale
  asc subscriptions     subscription and group localizations
  asc pricing           per-territory subscription prices from store/pricing.json
  asc screenshots       upload store/screenshots
  asc verify            read every field back and diff it against the local files
  asc submit            create a review submission and submit it
  asc values            render store/ASC-VALUES.md for the fields the API cannot set
  asc fastlane          export store/ into a fastlane metadata tree
  asc push              metadata, then subscriptions, then pricing

Google Play
  play whoami           what the service account can see: tracks, listings, subscriptions
  play listing          title, short and full description, per locale
  play images           icon, feature graphic, phone screenshots
  play subscriptions    subscriptions, base plans and the free trial offer
  play pricing          per-region prices from store/pricing.json
  play verify           read every field back and diff it against the local files
  play push             listing, then images, then subscriptions, then pricing

Both
  check store           validate store/metadata.json against both stores' field limits
  check prices          compare what Apple and Google actually charge, side by side
  init                  scaffold store/ in a repo that has none

Flags
  --root <path>         app repo to act on, default: nearest parent with store/metadata.json
  --dry-run             plan every write and send none
  --verbose             print each request
  --help, --version

Credentials come from the app repo's .env or the environment, never from this package.
  ASC_KEY_ID  ASC_ISSUER_ID  ASC_PRIVATE_KEY_PATH
  PLAY_SERVICE_ACCOUNT_KEY_PATH
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(modulePath, args) {
  const result = spawnSync(process.execPath, [path.join(SRC, modulePath), ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) fail(`Could not run ${modulePath}: ${result.error.message}`);
  return result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(pkg.version);
    return 0;
  }

  // Pulled out before anything else so the root is settled before a child starts and reads
  // it. Removed from the argv the child sees, because the command modules parse their own
  // flags by scanning for exact strings and an unknown pair would sit there as a positional.
  const rootIndex = argv.indexOf('--root');
  if (rootIndex !== -1) {
    const value = argv[rootIndex + 1];
    if (!value) fail('--root needs a path.');
    const { setRoot } = require('../src/lib/root');
    try {
      setRoot(value);
    } catch (error) {
      fail(error.message);
    }
    argv.splice(rootIndex, 2);
  }

  if (argv[0] === 'init') {
    return require('../src/lib/init').run(argv.slice(1));
  }

  const group = COMMANDS[argv[0]];
  if (!group) {
    fail(`Unknown store "${argv[0]}". Try one of: ${Object.keys(COMMANDS).join(', ')}, init.`);
  }

  const target = group[argv[1]];
  if (!target) {
    fail(
      `Unknown command "${`${argv[0]} ${argv[1] ?? ''}`.trim()}".\n` +
        `Available: ${Object.keys(group).join(', ')}`,
    );
  }

  const rest = argv.slice(2);
  const steps = Array.isArray(target) ? target : [target];

  for (const step of steps) {
    if (steps.length > 1) console.log(`\n=== ${path.basename(step, '.js')} ===\n`);
    const status = run(step, rest);
    // A sequence stops at the first failure rather than pressing on: pushing prices onto
    // subscriptions that failed to be created writes them onto whatever is there instead.
    if (status !== 0) return status;
  }

  return 0;
}

process.exit(main());
