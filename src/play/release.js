#!/usr/bin/env node
'use strict';

/**
 * Play tracks and staged rollout.
 *
 *   store-kit play release                             what every track is serving
 *   store-kit play release --track production --rollout 0.1
 *   store-kit play release --track production --rollout 1        finish the rollout
 *   store-kit play release --track production --halt             stop it
 *   store-kit play release --track internal --promote production
 *
 * The largest hole this package had. Everything else here shapes how an app is described;
 * this decides who is running it. A staged rollout is the only lever that limits the blast
 * radius of a bad build, and unlike the App Store's phased release it can be steered to an
 * arbitrary fraction rather than a fixed seven day ramp.
 *
 * It does not upload binaries. Uploading an AAB means shipping and holding a large file, a
 * signing story and a mapping file, and EAS and the Play console both already do that well.
 * What they do badly is everything after: this promotes an existing version code between
 * tracks and moves the fraction, which is the part somebody does at nine in the evening
 * when the crash rate moves.
 *
 * Reads are the default. Every write needs an explicit flag, because a rollout is visible to
 * real users the moment it commits.
 */

const { PlayApi } = require('./api');
const { withEdit, readThroughEdit } = require('./edit');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const HALT = argv.includes('--halt');

const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
};

const TRACK = value('--track');
const ROLLOUT = value('--rollout') === null ? null : Number(value('--rollout'));
const PROMOTE = value('--promote');

function describe(track) {
  const lines = [`  ${track.track}`];
  for (const release of track.releases ?? []) {
    const codes = (release.versionCodes ?? []).join(', ') || '(no build)';
    const fraction =
      release.userFraction !== undefined
        ? ` ${(release.userFraction * 100).toFixed(1)}% of users`
        : release.status === 'completed'
          ? ' everyone'
          : '';
    lines.push(`    ${(release.status ?? '?').padEnd(12)} ${codes}${fraction}`);
    if (release.name) lines.push(`      name: ${release.name}`);
  }
  if ((track.releases ?? []).length === 0) lines.push('    (no releases)');
  return lines.join('\n');
}

async function main() {
  const api = new PlayApi({ dryRun: DRY_RUN, verbose: VERBOSE });

  const tracks = await readThroughEdit(api, (editId) =>
    api.get(`/applications/${api.package}/edits/${editId}/tracks`),
  );
  const all = tracks.tracks ?? [];

  console.log(`${api.package}\n`);
  for (const track of all) console.log(describe(track));

  const writing = ROLLOUT !== null || HALT || PROMOTE;
  if (!writing) {
    console.log('\nRead only. Pass --rollout <0..1>, --halt, or --promote <track> to change one.');
    return;
  }

  if (!TRACK) throw new Error('--track is required when changing a release.');
  const source = all.find((t) => t.track === TRACK);
  if (!source) {
    throw new Error(`No track named "${TRACK}". Existing: ${all.map((t) => t.track).join(', ')}.`);
  }

  // The release being steered is the one that is live or rolling, not a draft: a draft has
  // no users and halting or ramping it means nothing.
  const release = (source.releases ?? []).find((r) =>
    ['inProgress', 'completed', 'halted'].includes(r.status),
  );
  if (!release) throw new Error(`Track "${TRACK}" has no in-progress or completed release.`);

  if (ROLLOUT !== null && (ROLLOUT <= 0 || ROLLOUT > 1)) {
    throw new Error(`--rollout takes a fraction above 0 and up to 1, not ${ROLLOUT}.`);
  }

  const target = PROMOTE ?? TRACK;
  const next = { ...release };

  if (HALT) {
    next.status = 'halted';
    delete next.userFraction;
  } else if (ROLLOUT === 1) {
    // A completed release serves everyone, and Play rejects a userFraction alongside it.
    next.status = 'completed';
    delete next.userFraction;
  } else if (ROLLOUT !== null) {
    next.status = 'inProgress';
    next.userFraction = ROLLOUT;
  }

  console.log(
    `\n${DRY_RUN ? 'Planning' : 'Applying'} on ${target}: ` +
      `${release.status}${release.userFraction ? ` at ${(release.userFraction * 100).toFixed(1)}%` : ''}` +
      ` -> ${next.status}${next.userFraction ? ` at ${(next.userFraction * 100).toFixed(1)}%` : ''}` +
      ` (build ${(next.versionCodes ?? []).join(', ')})`,
  );

  await withEdit(
    api,
    async (editId) => {
      await api.patch(
        `/applications/${api.package}/edits/${editId}/tracks/${encodeURIComponent(target)}`,
        { track: target, releases: [next] },
      );
    },
    { label: `release:${target}` },
  );

  console.log(DRY_RUN ? '\nDry run. The edit was validated and abandoned.' : '\nDone.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
