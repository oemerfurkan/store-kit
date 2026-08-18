'use strict';

/**
 * Resolves the handful of App Store Connect object ids every push script needs.
 *
 * Ids are looked up by bundle id and product id rather than hardcoded, even though
 * store/metadata.json happens to record two of them. A hardcoded id that has gone stale
 * does not fail loudly, it writes a description onto whatever object now holds that id,
 * and there is no undo for that. Looking them up costs three requests.
 */

const path = require('node:path');

const ROOT = require('../lib/root').root();
const metadata = require(path.join(ROOT, 'store', 'metadata.json'));

/**
 * The version states App Store Connect will let you edit metadata on.
 *
 * Anything else, and in particular READY_FOR_DISTRIBUTION, belongs to a version that is
 * already live: writing to it is rejected, and the rejection reads like a permissions
 * problem rather than a "you need a new version" problem.
 */
const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'WAITING_FOR_REVIEW',
  'INVALID_BINARY',
]);

async function resolveApp(client) {
  const bundleId = metadata.shared.bundleId;
  const apps = await client.list(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);

  if (apps.length === 0) {
    throw new Error(
      `No app on this team has the bundle id ${bundleId}. Either the key belongs to a ` +
        'different team, or the app record was never created.',
    );
  }

  return { id: apps[0].id, attributes: apps[0].attributes };
}

/**
 * The App Info record, which holds name, subtitle and privacy URL.
 *
 * These live apart from the version because they are not versioned: changing the subtitle
 * changes it for the listing as a whole. An app has one App Info per review state, so the
 * editable one is the one that is not already approved.
 */
async function resolveAppInfo(client, appId) {
  const infos = await client.list(`/v1/apps/${appId}/appInfos`);
  const editable = infos.find(
    (info) => info.attributes.appStoreState !== 'READY_FOR_SALE' || infos.length === 1,
  );
  return editable ?? infos[0];
}

/**
 * The version carrying description, keywords, promotional text and What's New.
 */
async function resolveVersion(client, appId) {
  const versions = await client.list(`/v1/apps/${appId}/appStoreVersions`);
  const editable = versions.find((version) =>
    EDITABLE_VERSION_STATES.has(version.attributes.appVersionState ?? version.attributes.appStoreState),
  );

  if (!editable) {
    const states = versions
      .map((v) => `${v.attributes.versionString} (${v.attributes.appVersionState ?? v.attributes.appStoreState})`)
      .join(', ');
    throw new Error(
      `No editable version found. Existing versions: ${states || 'none'}. ` +
        'Create a new version in App Store Connect before pushing metadata.',
    );
  }

  return editable;
}

async function resolveSubscriptions(client, appId) {
  const groups = await client.list(`/v1/apps/${appId}/subscriptionGroups`);
  if (groups.length === 0) throw new Error('This app has no subscription groups.');

  const wanted = new Map(
    metadata.inAppPurchases.products.map((product) => [product.productId, product]),
  );

  const found = [];
  for (const group of groups) {
    const subscriptions = await client.list(`/v1/subscriptionGroups/${group.id}/subscriptions`);
    for (const subscription of subscriptions) {
      const local = wanted.get(subscription.attributes.productId);
      if (local) found.push({ id: subscription.id, attributes: subscription.attributes, local });
    }
  }

  const missing = [...wanted.keys()].filter(
    (productId) => !found.some((entry) => entry.attributes.productId === productId),
  );
  if (missing.length > 0) {
    throw new Error(
      `These product ids are in store/metadata.json but not in App Store Connect: ` +
        `${missing.join(', ')}. A product id can never be renamed once created, so check the ` +
        'spelling in ASC rather than changing it there to match.',
    );
  }

  return { group: groups[0], subscriptions: found };
}

module.exports = { ROOT, metadata, resolveApp, resolveAppInfo, resolveVersion, resolveSubscriptions };
