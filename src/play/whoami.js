#!/usr/bin/env node
'use strict';

/**
 * Says who the credential is and what it can actually reach.
 *
 *   node scripts/play/whoami.js
 *
 * The mirror of `scripts/asc/whoami.js`, and the first thing to run when something else
 * fails. Play access has more ways to be half-working than App Store Connect does: the
 * service account has to exist in Google Cloud, the Play Developer API has to be enabled on
 * that project, the account has to be invited in Play Console, and the invitation carries a
 * separate grant per capability. Any one of those missing produces a 403 somewhere downstream
 * with no hint about which.
 *
 * So this probes each capability separately and reports them one per line, including the one
 * that cannot pass until a build exists. Permission changes also take up to 24 hours to
 * propagate on a freshly linked project, which makes "it was set up correctly and still
 * fails" a normal state rather than a contradiction.
 */

const { PlayApi, PlayError } = require('./api');
const { readThroughEdit } = require('./edit');

async function probe(label, run) {
  try {
    const detail = await run();
    console.log(`  ok       ${label}${detail ? `  ${detail}` : ''}`);
    return true;
  } catch (error) {
    const status = error instanceof PlayError ? error.status : '';
    console.log(`  FAILED   ${label}  ${status} ${error.detail ?? error.message.split('\n')[0]}`);
    return false;
  }
}

async function main() {
  const api = new PlayApi({ verbose: process.argv.includes('--verbose') });

  console.log(`service account  ${api.serviceAccountEmail}`);
  console.log(`package          ${api.package}\n`);

  await probe('token exchange', async () => {
    await api.token();
    return '';
  });

  await probe('read subscription catalog', async () => {
    const subs = await api.list(`/applications/${api.package}/subscriptions`, 'subscriptions');
    return `${subs.length} subscription(s)`;
  });

  // Expected to fail here with 403 "Please migrate to the new publishing API". That endpoint
  // is the old one-time-product catalog and Google has closed it to new apps. This app sells
  // subscriptions only, and subscriptions live on the newer endpoint probed above, so the
  // failure is a fact about the API rather than about this credential. Kept as a probe
  // because a 403 for any *other* reason would be a real permissions problem.
  await probe('read in-app product catalog (legacy)', async () => {
    const products = await api.list(`/applications/${api.package}/inappproducts`, 'inappproduct');
    return `${products.length} product(s)`;
  });

  await probe('open an edit', async () => {
    const tracks = await readThroughEdit(api, (editId) =>
      api.get(`/applications/${api.package}/edits/${editId}/tracks`),
    );
    const withReleases = (tracks.tracks ?? []).filter((t) => (t.releases ?? []).length > 0);
    return withReleases.length > 0
      ? `${withReleases.map((t) => t.track).join(', ')} have releases`
      : 'no track has a release yet';
  });

  // The check RevenueCat runs and the one that fails before a build exists. Probed with a
  // token that cannot be real: the answer worth reading is which error comes back, not
  // whether it succeeds. "purchaseToken not found" means the endpoint works and the app is
  // visible to it. "No application was found for the given package name" means Play cannot
  // resolve the app for this API at all, which stays true until something has been published
  // to a track. Internal testing counts.
  await probe('read subscription purchases', async () => {
    await api.get(
      `/applications/${api.package}/purchases/subscriptionsv2/tokens/whoami-probe-not-a-token`,
    );
    return '';
  });

  console.log(
    '\nA failing purchases probe with "No application was found" is expected until a build\n' +
      'has been uploaded to any track, and is what leaves RevenueCat showing "credentials\n' +
      'need attention". It is not a credentials problem and no retry will clear it.',
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
