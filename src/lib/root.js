'use strict';

/**
 * Finds the app repo this run is about, and reads its credentials.
 *
 * Every script in this package used to live inside one app repo, where the root was
 * `path.resolve(__dirname, '..', '..')` and that was always right. Inside a package it is
 * always wrong: it resolves to somewhere in node_modules, where there is no store folder
 * and no .env. So the root is discovered instead of assumed.
 *
 * Discovery walks up from the working directory looking for `store/metadata.json`, which
 * is the one file every command here needs. Walking up rather than requiring the exact
 * directory means `store-kit asc verify` works from a subfolder, the way git does.
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = path.join('store', 'metadata.json');

let cached = null;

/**
 * @param {string} [from] directory to start from, defaults to the working directory
 * @returns {string} absolute path to the app repo root
 */
function findRoot(from) {
  // An explicit answer always wins, and is checked rather than trusted: a typo'd path that
  // silently falls back to discovery would push one app's metadata into another app.
  const explicit = process.env.STORE_KIT_ROOT;
  if (explicit) {
    const resolved = path.resolve(expandHome(explicit));
    if (!fs.existsSync(path.join(resolved, MARKER))) {
      throw new Error(`STORE_KIT_ROOT is ${resolved}, which has no ${MARKER}.`);
    }
    return resolved;
  }

  let dir = path.resolve(from ?? process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `No ${MARKER} found in ${path.resolve(from ?? process.cwd())} or any parent directory. ` +
      'Run this from an app repo, or set STORE_KIT_ROOT. `store-kit init` scaffolds a new one.',
  );
}

/** Memoised, because a single command resolves the root from a dozen different modules. */
function root() {
  if (cached === null) cached = findRoot();
  return cached;
}

/** Test seam and the `--root` flag's landing point. Clears the memo so the next call re-reads. */
function setRoot(dir) {
  const resolved = path.resolve(expandHome(dir));
  if (!fs.existsSync(path.join(resolved, MARKER))) {
    throw new Error(`--root ${resolved} has no ${MARKER}.`);
  }
  cached = resolved;
  process.env.STORE_KIT_ROOT = resolved;
  return resolved;
}

function expandHome(value) {
  return value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
}

/**
 * Loads KEY=value pairs out of the app repo's .env without pulling in dotenv.
 *
 * Deliberately does not overwrite anything already in the environment, so a value exported
 * in the shell for a one-off run beats the file rather than being silently ignored.
 *
 * Runs at most once per process. Both store clients call it from their constructor and a
 * push that touches both would otherwise re-read the file for no reason.
 */
let envLoaded = false;
function loadDotEnv() {
  if (envLoaded) return;
  envLoaded = true;

  const file = path.join(root(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

/** Absolute path inside the app repo. `inRoot('store', 'pricing.json')`. */
function inRoot(...parts) {
  return path.join(root(), ...parts);
}

module.exports = { findRoot, root, setRoot, loadDotEnv, inRoot, expandHome, MARKER };
