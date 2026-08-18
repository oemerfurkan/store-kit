#!/usr/bin/env node
'use strict';

/**
 * How and when an approved version goes live, plus the version-level attributes nothing
 * else was writing.
 *
 *   store-kit asc release                     show the current settings
 *   store-kit asc release --dry-run
 *   store-kit asc release --apply             write releaseType, copyright, usesIdfa
 *   store-kit asc release --phased start|pause|resume|complete
 *
 * Two separate things live here because they are the same decision from the user's side.
 *
 * The version attributes: `copyright`, which every listing needs and which lived in
 * store/metadata.json unpushed; `releaseType`, which decides whether an approved build ships
 * by itself, waits for a button, or waits for a date; and `earliestReleaseDate` for the
 * scheduled case.
 *
 * The phased release: a separate object that ramps an update over seven days rather than
 * shipping it to everyone at once. It is worth using for anything that touches purchase or
 * data code, because it is the only lever that limits the blast radius of a bad build, and
 * pausing it is instant while pulling a version is not.
 *
 * Reads are the default. Writes need `--apply` or `--phased` because releasing is the one
 * action here somebody can take by accident and cannot take back.
 */

const { AppStoreConnect, AscError } = require('./api');
const { metadata, resolveApp, resolveVersion } = require('./context');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const APPLY = argv.includes('--apply');

const phasedFlag = argv.indexOf('--phased');
const PHASED = phasedFlag === -1 ? null : argv[phasedFlag + 1];

const PHASED_STATE = {
  start: 'ACTIVE',
  resume: 'ACTIVE',
  pause: 'PAUSED',
  complete: 'COMPLETE',
};

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN, verbose: VERBOSE });
  const app = await resolveApp(client);
  const version = await resolveVersion(client, app.id);
  const a = version.attributes;

  console.log(`Version ${a.versionString} (${a.appVersionState ?? a.appStoreState})\n`);
  console.log(`  releaseType          ${a.releaseType ?? '(unset)'}`);
  console.log(`  earliestReleaseDate  ${a.earliestReleaseDate ?? '(none)'}`);
  console.log(`  copyright            ${a.copyright ?? '(unset)'}`);
  console.log(`  usesIdfa             ${a.usesIdfa ?? '(unset)'}`);

  let phased = null;
  try {
    phased = (await client.get(`/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`))
      .data;
  } catch (error) {
    if (!(error instanceof AscError) || error.status !== 404) throw error;
  }
  console.log(
    `  phased release       ${phased ? `${phased.attributes.phasedReleaseState} (day ${phased.attributes.currentDayNumber ?? '?'})` : '(none)'}`,
  );

  if (PHASED) {
    const state = PHASED_STATE[PHASED];
    if (!state) {
      throw new Error(`--phased takes ${Object.keys(PHASED_STATE).join(', ')}, not "${PHASED}".`);
    }
    console.log(`\n${DRY_RUN ? 'Planning' : 'Applying'} phased release: ${PHASED} -> ${state}`);
    if (phased) {
      await client.patch(`/v1/appStoreVersionPhasedReleases/${phased.id}`, {
        data: {
          type: 'appStoreVersionPhasedReleases',
          id: phased.id,
          attributes: { phasedReleaseState: state },
        },
      });
    } else {
      await client.post('/v1/appStoreVersionPhasedReleases', {
        data: {
          type: 'appStoreVersionPhasedReleases',
          attributes: { phasedReleaseState: state },
          relationships: {
            appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
          },
        },
      });
    }
  }

  if (APPLY) {
    const release = metadata.release ?? {};
    const attributes = {};
    if (metadata.shared?.copyright !== undefined) attributes.copyright = metadata.shared.copyright;
    for (const key of ['releaseType', 'earliestReleaseDate', 'usesIdfa']) {
      if (release[key] !== undefined) attributes[key] = release[key];
    }

    const changes = Object.entries(attributes).filter(([k, v]) => a[k] !== v);
    console.log(`\n${DRY_RUN ? 'Planning' : 'Applying'} version attributes:`);
    for (const [k, v] of changes) console.log(`  ${k.padEnd(20)} ${a[k] ?? '(unset)'} -> ${v}`);
    if (changes.length === 0) console.log('  (nothing to change)');

    if (changes.length > 0) {
      await client.patch(`/v1/appStoreVersions/${version.id}`, {
        data: { type: 'appStoreVersions', id: version.id, attributes },
      });
    }
  }

  if (!APPLY && !PHASED) {
    console.log('\nRead only. Pass --apply to write, or --phased start|pause|resume|complete.');
  } else if (DRY_RUN) {
    console.log('\nDry run. Nothing was written.');
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
