#!/usr/bin/env node
'use strict';

/**
 * The age rating questionnaire.
 *
 *   store-kit asc age-rating --pull        capture the live answers into metadata.json
 *   store-kit asc age-rating --dry-run
 *   store-kit asc age-rating
 *
 * Twenty nine questions that decide the rating badge on the listing and, in several
 * countries, whether the app is shown to anybody at all. It is one object hanging off App
 * Info and it has always been a plain PATCH; the reason it feels like a console-only form is
 * that nobody wired it up, not that Apple withheld it.
 *
 * Start with `--pull`. Retyping twenty nine enum answers from memory into JSON is how a
 * config file ends up quietly disagreeing with the app it describes, and a wrong answer here
 * is a rejection rather than a warning.
 *
 * Answers are enums, and Apple names every accepted value in the error when one is wrong, so
 * a typo fails loudly rather than being coerced. The common ones are NONE, INFREQUENT_OR_MILD
 * and FREQUENT_OR_INTENSE; several fields are plain booleans.
 */

const { AppStoreConnect } = require('./api');
const { metadata, resolveApp, resolveAppInfo } = require('./context');
const { writeBlock } = require('../lib/pull');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const PULL = argv.includes('--pull');

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN && !PULL, verbose: VERBOSE });
  const app = await resolveApp(client);
  const info = await resolveAppInfo(client, app.id);

  const live = (await client.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`)).data;

  if (PULL) {
    // Nulls are dropped rather than recorded. A null is "not answered", and writing it back
    // as an explicit answer would turn an unanswered question into a claim.
    const block = {
      _comment:
        'Age rating questionnaire. Pulled from App Store Connect with `store-kit asc ' +
        'age-rating --pull`. Enum answers are usually NONE, INFREQUENT_OR_MILD or ' +
        'FREQUENT_OR_INTENSE; Apple lists every accepted value in the error when one is wrong.',
    };
    for (const [key, value] of Object.entries(live.attributes)) {
      if (value !== null && value !== undefined) block[key] = value;
    }
    const { file, changed } = writeBlock('ageRating', block);
    console.log(
      changed
        ? `Pulled ${Object.keys(block).length - 1} answer(s) into ${file.replace(process.cwd(), '.')}`
        : 'Age rating already matches store/metadata.json.',
    );
    return;
  }

  const local = metadata.ageRating;
  if (!local) {
    throw new Error(
      'store/metadata.json has no `ageRating` block. Run `store-kit asc age-rating --pull` ' +
        'to capture the answers that are already live, then edit them there.',
    );
  }

  const attributes = {};
  for (const [key, value] of Object.entries(local)) {
    if (key.startsWith('_')) continue;
    attributes[key] = value;
  }

  const changes = Object.entries(attributes).filter(
    ([key, value]) => live.attributes[key] !== value,
  );

  console.log(
    `${DRY_RUN ? 'Planning' : 'Pushing'} ${Object.keys(attributes).length} answer(s), ` +
      `${changes.length} of them different from what is live.\n`,
  );
  for (const [key, value] of changes) {
    console.log(`  ${key.padEnd(40)} ${String(live.attributes[key])} -> ${String(value)}`);
  }
  if (changes.length === 0) console.log('  (nothing to change)');

  if (changes.length > 0) {
    await client.patch(`/v1/ageRatingDeclarations/${live.id}`, {
      data: { type: 'ageRatingDeclarations', id: live.id, attributes },
    });
  }

  console.log(DRY_RUN ? '\nDry run. Nothing was written.' : '\nDone.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
