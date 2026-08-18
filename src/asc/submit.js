#!/usr/bin/env node
'use strict';

/**
 * Submits the editable App Store version for review.
 *
 *   node scripts/asc/submit.js --dry-run
 *   node scripts/asc/submit.js
 *
 * Submission is three calls, not one, and the middle one is the reason this is a script
 * rather than a line in a README. A review submission is a container: you create it for the
 * app, add the version to it as an item, and only then flip it to submitted. Stopping after
 * the first two leaves an open container in App Store Connect that looks like a submission
 * in the UI and is not one, which is a confusing state to debug later.
 *
 * An open container from an earlier attempt is reused rather than duplicated. Apple allows
 * only one in progress at a time, and creating a second answers with a 409 that reads like a
 * permissions problem.
 */

const { AppStoreConnect } = require('./api');
const { resolveApp, resolveVersion } = require('./context');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

async function main() {
  const client = new AppStoreConnect({ dryRun: false, verbose: argv.includes('--verbose') });
  const app = await resolveApp(client);
  const version = await resolveVersion(client, app.id);
  const state = version.attributes.appStoreState ?? version.attributes.appVersionState;

  console.log(`Version ${version.attributes.versionString} is ${state}.`);

  // A version with no build cannot be submitted, and Apple's error for it is generic enough
  // that it is worth catching here where the cause is obvious.
  const build = await client.get(`/v1/appStoreVersions/${version.id}/build`).catch(() => null);
  const buildAttrs = build?.data?.attributes;
  if (!buildAttrs) {
    throw new Error('No build is attached to this version. Select one before submitting.');
  }
  console.log(`Build ${buildAttrs.version} (${buildAttrs.processingState}) is attached.`);

  if (state !== 'PREPARE_FOR_SUBMISSION' && state !== 'REJECTED' && state !== 'DEVELOPER_REJECTED') {
    throw new Error(`Version is ${state}; nothing to submit.`);
  }

  const open = (
    await client.list(
      `/v1/reviewSubmissions?filter[app]=${app.id}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES`,
    )
  )[0];

  if (DRY_RUN) {
    console.log(
      open
        ? `Dry run. Would reuse the open review submission ${open.id} and submit.`
        : 'Dry run. Would create a review submission, add this version, and submit.',
    );
    return;
  }

  let submission = open;
  if (submission) {
    console.log(`Reusing open review submission ${submission.id} (${submission.attributes.state}).`);
  } else {
    const created = await client.post('/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    });
    submission = created.data;
    console.log(`Created review submission ${submission.id}.`);
  }

  const items = await client.list(`/v1/reviewSubmissions/${submission.id}/items`);
  const already = items.some((i) => i.relationships?.appStoreVersion?.data?.id === version.id);
  if (already) {
    console.log('Version is already an item on this submission.');
  } else {
    await client.post('/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
        },
      },
    });
    console.log('Added the version to the submission.');
  }

  await client.patch(`/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });

  const after = await client.get(`/v1/reviewSubmissions/${submission.id}`);
  console.log(`\nSubmitted. State is now ${after?.data?.attributes?.state}.`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
