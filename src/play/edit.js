'use strict';

/**
 * The edit transaction, which App Store Connect has no equivalent of.
 *
 * Every listing, image and track change on Play happens inside an *edit*: you open one, make
 * the writes against its id, then validate and commit, and only at commit does anything
 * become real. Nothing is written incrementally, so a run that dies halfway leaves the
 * listing untouched. That is a better model than ASC's, where a failed metadata push leaves
 * some localizations updated and some not.
 *
 * It also means a dry run here is worth far more than a dry run there. `--dry-run` opens a
 * real edit, sends the real writes, asks Google to validate them, and then abandons instead
 * of committing. So it exercises the actual API and surfaces the actual errors, rather than
 * printing what it would have sent.
 *
 * The failure mode to know about: a crashed run leaves a dangling edit, and Play allows only
 * one open edit per app. The next run then fails on `edits.insert`. `withEdit` abandons on
 * error for exactly that reason, and `abandonAll` is the manual escape hatch.
 */

/**
 * Runs `work` inside an edit and commits it, or abandons it and rethrows.
 *
 * @param {import('./api').PlayApi} api
 * @param {(editId: string) => Promise<void>} work
 * @param {{ label?: string, changesNotSentForReview?: boolean }} [options]
 */
async function withEdit(api, work, options = {}) {
  const label = options.label ?? 'edit';

  // The api-level dry-run guard is deliberately switched off for everything inside the edit,
  // and this is the opposite of what it does elsewhere. Nothing written into an edit exists
  // until the commit, so sending the real writes costs nothing and buys the thing that makes
  // this dry run worth having: Google validates the actual payload and names the actual
  // problems. Suppressing the writes would validate an empty edit and report success no
  // matter what was in metadata.json. The commit is the only step actually skipped.
  const dryRun = api.dryRun;
  api.dryRun = false;

  const edit = await api.post(`/applications/${api.package}/edits`);
  const editId = edit.id;
  if (api.verbose) console.log(`  ${label}: opened edit ${editId}`);

  try {
    await work(editId);

    // Validate before commit, always. Commit validates too, but a commit that fails has
    // already spent the edit, and the error it returns names one problem rather than all of
    // them. Validating first gets the full list while the edit is still reusable.
    await api.post(`/applications/${api.package}/edits/${editId}:validate`);
    if (api.verbose) console.log(`  ${label}: validated`);

    if (dryRun) {
      await abandon(api, editId);
      console.log(`  ${label}: Google validated the edit, then it was abandoned uncommitted`);
      return null;
    }

    // `changesNotSentForReview` is only accepted once an app has something to review against.
    // Before the first release Play answers "Changes are sent for review automatically. The
    // query parameter changesNotSentForReview must not be set" and rejects the commit
    // outright, so passing it unconditionally makes every push fail on a new app, and
    // dropping it unconditionally would start sending half written listings to review the
    // moment the app is published. Ask for it, and take Google's word for it when it says the
    // question does not apply.
    const commitPath = `/applications/${api.package}/edits/${editId}:commit`;
    let committed;
    try {
      committed = await api.post(
        options.changesNotSentForReview ? `${commitPath}?changesNotSentForReview=true` : commitPath,
      );
    } catch (error) {
      if (!/changesNotSentForReview must not be set/i.test(error.detail ?? '')) throw error;
      if (api.verbose) {
        console.log(`  ${label}: app has no review to defer, committing without the flag`);
      }
      committed = await api.post(commitPath);
    }
    if (api.verbose) console.log(`  ${label}: committed`);
    return committed;
  } catch (error) {
    // Abandoning is best effort. The original error is what the caller needs to see, and a
    // failure to clean up must not replace it.
    await abandon(api, editId).catch(() => {});
    error.message += `\n\n  The edit ${editId} was abandoned, so nothing was written.`;
    throw error;
  } finally {
    api.dryRun = dryRun;
  }
}

async function abandon(api, editId) {
  // Deleting an edit is a write, but the dry-run guard in `request` would turn it into a
  // no-op and leave the edit dangling, which is the one thing this whole module exists to
  // prevent. So it goes out regardless of the flag.
  const wasDry = api.dryRun;
  api.dryRun = false;
  try {
    await api.delete(`/applications/${api.package}/edits/${editId}`);
  } finally {
    api.dryRun = wasDry;
  }
}

/**
 * Opens an edit purely to read through it, then abandons it.
 *
 * Tracks, listings and images are only readable inside an edit, so verification needs one
 * even though it writes nothing.
 */
async function readThroughEdit(api, read) {
  // Opening the edit has to go out even under --dry-run. It is a POST, so the dry-run guard
  // would hand back a fake id, and every read inside would then 404 against an edit that was
  // never created. Nothing is committed either way, so this is safe.
  const wasDry = api.dryRun;
  api.dryRun = false;
  let edit;
  try {
    edit = await api.post(`/applications/${api.package}/edits`);
  } finally {
    api.dryRun = wasDry;
  }

  try {
    return await read(edit.id);
  } finally {
    await abandon(api, edit.id).catch(() => {});
  }
}

module.exports = { withEdit, abandon, readThroughEdit };
