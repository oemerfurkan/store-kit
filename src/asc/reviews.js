#!/usr/bin/env node
'use strict';

/**
 * Customer reviews, and replies to them.
 *
 *   store-kit asc reviews                        the 20 most recent, newest first
 *   store-kit asc reviews --unanswered           only the ones with no reply
 *   store-kit asc reviews --rating 1,2           only these star ratings
 *   store-kit asc reviews --territory TUR,DEU
 *   store-kit asc reviews --reply <id> --text "…"
 *
 * An app shipping in twenty three languages collects reviews in twenty three languages, and
 * the console shows them one storefront at a time behind a picker. That is the reason this
 * exists: reading them all at once is the difference between noticing that every one star
 * review in one country says the same thing and never noticing it at all.
 *
 * A reply is public, permanent until edited, and attributed to the developer. So the reply
 * path takes an explicit review id and explicit text rather than anything that could send in
 * bulk. There is deliberately no way to reply to many reviews in one command.
 */

const { AppStoreConnect, AscError } = require('./api');
const { resolveApp } = require('./context');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const DRY_RUN = argv.includes('--dry-run');
const UNANSWERED = argv.includes('--unanswered');

const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
};

const RATINGS = value('--rating')?.split(',').map(Number) ?? null;
const TERRITORIES = value('--territory')?.split(',') ?? null;
const LIMIT = Number(value('--limit') ?? 20);
const REPLY_TO = value('--reply');
const TEXT = value('--text');

async function main() {
  const client = new AppStoreConnect({ dryRun: DRY_RUN, verbose: VERBOSE });
  const app = await resolveApp(client);

  if (REPLY_TO) {
    if (!TEXT) throw new Error('--reply needs --text "your reply".');
    if (TEXT.length > 5970) {
      throw new Error(`A reply is capped at 5970 characters; this one is ${TEXT.length}.`);
    }

    // Apple has no upsert here either: a review that already has a response needs the
    // response patched, and creating over it is rejected.
    let existing = null;
    try {
      existing = (await client.get(`/v1/customerReviews/${REPLY_TO}/response`)).data;
    } catch (error) {
      if (!(error instanceof AscError) || error.status !== 404) throw error;
    }

    console.log(`${DRY_RUN ? 'Planning' : existing ? 'Editing' : 'Posting'} reply to ${REPLY_TO}:\n`);
    console.log(`  ${TEXT}\n`);

    if (existing) {
      await client.patch(`/v1/customerReviewResponses/${existing.id}`, {
        data: {
          type: 'customerReviewResponses',
          id: existing.id,
          attributes: { responseBody: TEXT },
        },
      });
    } else {
      await client.post('/v1/customerReviewResponses', {
        data: {
          type: 'customerReviewResponses',
          attributes: { responseBody: TEXT },
          relationships: { review: { data: { type: 'customerReviews', id: REPLY_TO } } },
        },
      });
    }
    console.log(DRY_RUN ? 'Dry run. Nothing was posted.' : 'Posted. It appears publicly within a day.');
    return;
  }

  const query = [`limit=${Math.min(LIMIT, 200)}`, 'sort=-createdDate', 'include=response'];
  if (RATINGS) query.push(`filter[rating]=${RATINGS.join(',')}`);
  if (TERRITORIES) query.push(`filter[territory]=${TERRITORIES.join(',')}`);

  const page = await client.listFull(`/v1/apps/${app.id}/customerReviews?${query.join('&')}`);
  const responded = new Set(
    page.included.filter((i) => i.type === 'customerReviewResponses').map((i) => i.id),
  );

  const reviews = page.data.filter((review) =>
    UNANSWERED ? !review.relationships?.response?.data : true,
  );

  console.log(`${app.attributes.name}: ${reviews.length} review(s)\n`);
  for (const review of reviews) {
    const a = review.attributes;
    const answered = review.relationships?.response?.data
      ? responded.has(review.relationships.response.data.id)
        ? 'replied'
        : 'replied'
      : 'no reply';
    console.log(
      `  ${'*'.repeat(a.rating)}${'.'.repeat(5 - a.rating)}  ${a.territory}  ` +
        `${(a.createdDate ?? '').slice(0, 10)}  ${answered}`,
    );
    if (a.title) console.log(`    ${a.title}`);
    if (a.body) console.log(`    ${a.body.replace(/\n+/g, ' ').slice(0, 160)}`);
    console.log(`    id ${review.id}\n`);
  }

  if (reviews.length === 0) {
    console.log('  (none yet, or none matching the filters)');
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
