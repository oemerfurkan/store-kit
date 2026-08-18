#!/usr/bin/env node
'use strict';

/**
 * Play user reviews, and replies to them.
 *
 *   store-kit play reviews                       recent reviews, newest first
 *   store-kit play reviews --unanswered
 *   store-kit play reviews --rating 1,2
 *   store-kit play reviews --reply <id> --text "…"
 *
 * One thing to know before reading the output and concluding the app has few reviews: this
 * API only returns reviews created or edited in roughly the last week, and only from users
 * who left text. Play does not expose the full history here, so an empty result means
 * "nothing recent", never "nothing ever". The console's own list is the complete one.
 *
 * A reply is public and attributed to the developer, so replying takes an explicit review id
 * and explicit text. There is no bulk path on purpose.
 *
 * Reviews sit outside the edit transaction, unlike listings and tracks, so nothing here
 * opens or commits an edit.
 */

const { PlayApi } = require('./api');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const UNANSWERED = argv.includes('--unanswered');

const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
};

const RATINGS = value('--rating')?.split(',').map(Number) ?? null;
const LIMIT = Number(value('--limit') ?? 20);
const REPLY_TO = value('--reply');
const TEXT = value('--text');

async function main() {
  const api = new PlayApi({ dryRun: DRY_RUN, verbose: VERBOSE });

  if (REPLY_TO) {
    if (!TEXT) throw new Error('--reply needs --text "your reply".');
    if (TEXT.length > 350) {
      throw new Error(`Play caps a reply at 350 characters; this one is ${TEXT.length}.`);
    }
    console.log(`${DRY_RUN ? 'Planning' : 'Posting'} reply to ${REPLY_TO}:\n\n  ${TEXT}\n`);
    await api.post(`/applications/${api.package}/reviews/${encodeURIComponent(REPLY_TO)}:reply`, {
      replyText: TEXT,
    });
    console.log(DRY_RUN ? 'Dry run. Nothing was posted.' : 'Posted.');
    return;
  }

  const reviews = await api.list(
    `/applications/${api.package}/reviews?maxResults=${Math.min(LIMIT, 100)}`,
    'reviews',
  );

  const rows = reviews.filter((review) => {
    const comment = review.comments?.find((c) => c.userComment);
    if (!comment) return false;
    if (RATINGS && !RATINGS.includes(comment.userComment.starRating)) return false;
    if (UNANSWERED && review.comments.some((c) => c.developerComment)) return false;
    return true;
  });

  console.log(`${api.package}: ${rows.length} review(s) in the recent window\n`);

  for (const review of rows) {
    const user = review.comments.find((c) => c.userComment).userComment;
    const replied = review.comments.some((c) => c.developerComment);
    const when = user.lastModified?.seconds
      ? new Date(Number(user.lastModified.seconds) * 1000).toISOString().slice(0, 10)
      : '';
    console.log(
      `  ${'*'.repeat(user.starRating)}${'.'.repeat(5 - user.starRating)}  ` +
        `${(user.reviewerLanguage ?? '??').padEnd(6)} ${when}  ${replied ? 'replied' : 'no reply'}`,
    );
    if (review.authorName) console.log(`    ${review.authorName}`);
    if (user.text) console.log(`    ${user.text.replace(/\n+/g, ' ').slice(0, 160)}`);
    if (user.appVersionName) console.log(`    on ${user.appVersionName} / ${user.device ?? '?'}`);
    console.log(`    id ${review.reviewId}\n`);
  }

  if (rows.length === 0) {
    console.log(
      '  (nothing in the last week or so. This API only returns recently touched reviews,\n' +
        '   so this is not the full history.)',
    );
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
