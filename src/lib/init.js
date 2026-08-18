'use strict';

/**
 * Scaffolds `store/` in a repo that has none.
 *
 * Everything else in this package assumes store/metadata.json exists, including the root
 * finder, so this is the one command that cannot use it: it works from the current
 * directory outward and writes rather than reads.
 *
 * It never overwrites. A half-filled metadata.json holds hours of copy in twenty three
 * languages, and "scaffold a new project" is one typo away from "run it in the old one".
 */

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');

function readAppJson(dir) {
  const file = path.join(dir, 'app.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function run(args) {
  const target = path.resolve(args.find((a) => !a.startsWith('-')) ?? process.cwd());

  if (!fs.existsSync(target)) {
    console.error(`${target} does not exist.`);
    return 1;
  }

  const app = readAppJson(target);
  const expo = app?.expo ?? {};

  // Prefilled from app.json when there is one, because these three are the fields that make
  // every later command fail with a message about credentials when they are actually wrong.
  const substitutions = {
    __BUNDLE_ID__: expo.ios?.bundleIdentifier ?? 'com.example.app',
    __ANDROID_PACKAGE__: expo.android?.package ?? 'com.example.app',
    __APP_NAME__: expo.name ?? 'App Name',
    __SLUG__: expo.slug ?? 'app',
  };

  const written = [];
  const skipped = [];

  const copy = (from, to) => {
    const destination = path.join(target, to);
    if (fs.existsSync(destination)) {
      skipped.push(to);
      return;
    }
    let body = fs.readFileSync(path.join(TEMPLATES, from), 'utf8');
    for (const [token, value] of Object.entries(substitutions)) {
      body = body.split(token).join(value);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body);
    written.push(to);
  };

  copy(path.join('store', 'metadata.json'), path.join('store', 'metadata.json'));
  copy(path.join('store', 'pricing.json'), path.join('store', 'pricing.json'));
  copy('env.example', '.env.example');

  for (const file of written) console.log(`  created  ${file}`);
  for (const file of skipped) console.log(`  kept     ${file} (already there)`);

  if (written.length === 0) {
    console.log('\nNothing to do.');
    return 0;
  }

  console.log(
    `\nNext:\n` +
      `  1. Fill in store/metadata.json. Every top level key that has a "name" is a locale.\n` +
      `  2. Copy .env.example to .env and point it at your keys. Both are already ignored\n` +
      `     by git if this repo has the usual .gitignore; check that it is, before you paste.\n` +
      `  3. store-kit check store\n` +
      `  4. store-kit asc whoami\n`,
  );
  return 0;
}

module.exports = { run };
