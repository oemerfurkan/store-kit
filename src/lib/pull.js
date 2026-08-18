'use strict';

/**
 * Writes live store state back into store/metadata.json.
 *
 * Several App Store Connect surfaces were authored in the console long before anybody
 * decided the repo should own them: the age rating questionnaire, the reviewer contact
 * details, the categories. Asking someone to retype twenty nine age rating answers into
 * JSON, correctly, from memory, is how a config file ends up describing an app that does
 * not exist. So each of those commands takes `--pull`, reads what is actually live, and
 * writes it here. The repo becomes the source of truth by capture rather than by dictation.
 *
 * Formatting is preserved by detecting the file's own indent rather than imposing one, so a
 * pull shows up in `git diff` as the fields that changed and nothing else.
 */

const fs = require('node:fs');

const { inRoot } = require('./root');

function detectIndent(text) {
  const match = /\n(\s+)"/.exec(text);
  if (!match) return 2;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

/**
 * @param {string} key top level key in metadata.json to replace
 * @param {object} value what to put there
 * @returns {{ file: string, changed: boolean }}
 */
function writeBlock(key, value) {
  const file = inRoot('store', 'metadata.json');
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text);

  const before = JSON.stringify(data[key]);
  data[key] = value;
  if (JSON.stringify(data[key]) === before) return { file, changed: false };

  fs.writeFileSync(file, `${JSON.stringify(data, null, detectIndent(text))}\n`);
  return { file, changed: true };
}

module.exports = { writeBlock };
