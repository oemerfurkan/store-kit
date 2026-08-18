#!/usr/bin/env node
'use strict';

/**
 * The reviewer's contact details, demo account and notes.
 *
 *   store-kit asc review-details --pull       capture what is live into metadata.json
 *   store-kit asc review-details --dry-run
 *   store-kit asc review-details
 *
 * This is the form somebody retypes at two in the morning before every submission, and the
 * one where a stale phone number or a demo account that no longer works turns a two day
 * review into a two week one. It is a single object per version, `appStoreReviewDetail`,
 * and it has always been writable; nothing about it needed a console.
 *
 * A version gets one automatically when it is created, so this is nearly always a PATCH.
 * The POST path is kept for the case where it is genuinely absent, which happens on some
 * older apps.
 *
 * Three fields never touch the file: the demo account password, the contact phone and the
 * contact email. A demo password is a credential, and a phone number is personal data that
 * belongs to a person rather than to an app. store/metadata.json is tracked, and a repo that
 * is private today can be opened tomorrow, so the safe default is that it never held them.
 * They come from the environment instead:
 *
 *   ASC_DEMO_ACCOUNT_PASSWORD
 *   ASC_REVIEW_CONTACT_PHONE
 *   ASC_REVIEW_CONTACT_EMAIL
 *
 * A value written into the file anyway still works, for anyone who would rather keep it
 * there in a private repo. The environment wins when both are set.
 */

const { AppStoreConnect, AscError } = require('./api');
const { metadata, resolveApp, resolveVersion } = require('./context');
const { writeBlock } = require('../lib/pull');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const PULL = argv.includes('--pull');

/** Safe to record in a tracked file. */
const FILE_FIELDS = ['contactFirstName', 'contactLastName', 'demoAccountName', 'demoAccountRequired'];

/** Personal or secret. Environment first, file only as a deliberate override. */
const ENV_FIELDS = {
  contactPhone: 'ASC_REVIEW_CONTACT_PHONE',
  contactEmail: 'ASC_REVIEW_CONTACT_EMAIL',
  demoAccountPassword: 'ASC_DEMO_ACCOUNT_PASSWORD',
};

/** Shown as the first and last character only, so a wrong value is still recognisable. */
const mask = (value) =>
  value.length <= 4 ? '****' : `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN && !PULL, verbose: VERBOSE });
  const app = await resolveApp(client);
  const version = await resolveVersion(client, app.id);

  let live = null;
  try {
    live = (await client.get(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data;
  } catch (error) {
    if (!(error instanceof AscError) || error.status !== 404) throw error;
  }

  if (PULL) {
    if (!live) throw new Error('This version has no review detail to pull yet.');
    const block = {
      _comment:
        'Reviewer contact and notes. The phone, email and demo password are deliberately ' +
        'absent: they are personal or secret and this file is tracked. Set ' +
        'ASC_REVIEW_CONTACT_PHONE, ASC_REVIEW_CONTACT_EMAIL and ASC_DEMO_ACCOUNT_PASSWORD ' +
        'in .env instead.',
    };
    for (const field of FILE_FIELDS) {
      const value = live.attributes[field];
      if (value !== null && value !== undefined) block[field] = value;
    }
    block.text = live.attributes.notes ?? '';

    // Reported, never written. Somebody pulling for the first time needs to know these are
    // already set on the store side, or they will wonder why the push leaves them alone.
    const held = Object.entries(ENV_FIELDS)
      .filter(([field]) => live.attributes[field])
      .map(([field, env]) => `${field} is set on the store; put it in ${env} to manage it here`);
    if (held.length > 0) console.log(held.map((line) => `  note: ${line}`).join('\n'));
    const { file, changed } = writeBlock('reviewNotes', block);
    console.log(
      changed
        ? `Pulled review details into ${file.replace(process.cwd(), '.')}`
        : 'Review details already match store/metadata.json.',
    );
    return;
  }

  const local = metadata.reviewNotes ?? {};
  const attributes = {};
  for (const field of FILE_FIELDS) {
    if (local[field] !== undefined) attributes[field] = local[field];
  }
  if (local.text !== undefined) attributes.notes = local.text;

  // Absent means "leave whatever the store already has", which is the right default: these
  // are set once and rarely touched, and clearing a reviewer's contact email by omission
  // would be a worse failure than not managing it at all.
  for (const [field, env] of Object.entries(ENV_FIELDS)) {
    const value = process.env[env] ?? local[field];
    if (value) attributes[field] = value;
  }

  if (Object.keys(attributes).length === 0) {
    throw new Error(
      'store/metadata.json has no reviewNotes fields to push. Run with --pull to capture ' +
        'what is already live, then edit the file.',
    );
  }

  console.log(
    `${DRY_RUN ? 'Planning' : 'Pushing'} review details for version ${version.attributes.versionString}.\n`,
  );
  for (const [key, value] of Object.entries(attributes)) {
    const shown = ENV_FIELDS[key] ? mask(String(value)) : String(value);
    console.log(`  ${key.padEnd(20)} ${shown.length > 60 ? `${shown.slice(0, 57)}...` : shown}`);
  }

  if (live) {
    await client.patch(`/v1/appStoreReviewDetails/${live.id}`, {
      data: { type: 'appStoreReviewDetails', id: live.id, attributes },
    });
  } else {
    await client.post('/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes,
        relationships: {
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
  }

  console.log(DRY_RUN ? '\nDry run. Nothing was written.' : '\nDone.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
