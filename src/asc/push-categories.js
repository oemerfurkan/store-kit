#!/usr/bin/env node
'use strict';

/**
 * App Store categories, primary and secondary, with their subcategories.
 *
 *   store-kit asc categories --list       every category id Apple accepts
 *   store-kit asc categories --pull       capture what is live into metadata.json
 *   store-kit asc categories --dry-run
 *   store-kit asc categories
 *
 * The category is the second strongest ranking signal after the name, and it is a
 * relationship on App Info rather than an attribute, which is the only reason it looks
 * harder than it is: you PATCH the relationship with a category id, not a string.
 *
 * `--list` exists because the ids are not the display names. Games have subcategories and
 * most other categories do not, and guessing produces a 422 that names the constraint but
 * not the id you wanted.
 */

const { AppStoreConnect } = require('./api');
const { metadata, resolveApp, resolveAppInfo } = require('./context');
const { writeBlock } = require('../lib/pull');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const PULL = argv.includes('--pull');
const LIST = argv.includes('--list');

const SLOTS = [
  ['primaryCategory', 'primaryCategory'],
  ['primarySubcategoryOne', 'primarySubcategoryOne'],
  ['primarySubcategoryTwo', 'primarySubcategoryTwo'],
  ['secondaryCategory', 'secondaryCategory'],
  ['secondarySubcategoryOne', 'secondarySubcategoryOne'],
  ['secondarySubcategoryTwo', 'secondarySubcategoryTwo'],
];

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN && !PULL, verbose: VERBOSE });

  if (LIST) {
    const categories = await client.list('/v1/appCategories?include=subcategories&limit=200');
    const parents = categories.filter((c) => !c.relationships?.parent?.data);
    for (const parent of parents.sort((a, b) => a.id.localeCompare(b.id))) {
      const subs = (parent.relationships?.subcategories?.data ?? []).map((s) => s.id);
      console.log(`  ${parent.id}${subs.length ? `\n      ${subs.join(', ')}` : ''}`);
    }
    return;
  }

  const app = await resolveApp(client);
  const info = await resolveAppInfo(client, app.id);

  const full = await client.get(
    `/v1/appInfos/${info.id}?include=${SLOTS.map(([, r]) => r).join(',')}`,
  );
  const liveIds = {};
  for (const [key, rel] of SLOTS) {
    liveIds[key] = full.data.relationships?.[rel]?.data?.id ?? null;
  }

  if (PULL) {
    const shared = { ...(metadata.shared ?? {}) };
    for (const [key] of SLOTS) {
      if (liveIds[key]) shared[key] = liveIds[key];
      else delete shared[key];
    }
    const { file, changed } = writeBlock('shared', shared);
    console.log(
      changed
        ? `Pulled categories into ${file.replace(process.cwd(), '.')}`
        : 'Categories already match store/metadata.json.',
    );
    return;
  }

  const shared = metadata.shared ?? {};
  const relationships = {};
  const plan = [];

  for (const [key, rel] of SLOTS) {
    const want = shared[key];
    if (want === undefined) continue;
    if (want === liveIds[key]) continue;
    // An explicit null clears a slot, which is how a secondary category gets removed. There
    // is no other way to say it: omitting the relationship leaves it alone.
    relationships[rel] = { data: want === null ? null : { type: 'appCategories', id: want } };
    plan.push(`  ${key.padEnd(24)} ${liveIds[key] ?? '(none)'} -> ${want ?? '(none)'}`);
  }

  console.log(`${DRY_RUN ? 'Planning' : 'Pushing'} categories for ${app.attributes.name}.\n`);
  console.log(plan.length ? plan.join('\n') : '  (nothing to change)');

  if (plan.length > 0) {
    await client.patch(`/v1/appInfos/${info.id}`, {
      data: { type: 'appInfos', id: info.id, relationships },
    });
  }

  console.log(DRY_RUN ? '\nDry run. Nothing was written.' : '\nDone.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
