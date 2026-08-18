'use strict';

/**
 * Create-or-update against App Store Connect.
 *
 * The API has no upsert. Creating over an existing object is rejected and patching one that
 * does not exist is a 404, so the caller has to already know which of the two it is. That is
 * why every push script lists the current localizations before it writes anything: the list
 * is not a nicety, it is how the verb gets chosen.
 *
 * The list can still be stale by the time it is used, and not because of a race with another
 * person. Adding an App Info localization for a new language makes App Store Connect create
 * the matching App Store Version localization on its own, seeded from the primary language.
 * So a run that correctly observed "nl-NL does not exist" on both objects, then created the
 * first, finds that creating the second is now a conflict. The list was right when it was
 * taken and wrong one request later.
 *
 * Hence the third path: on a conflict, re-read the collection, find the object Apple made,
 * and patch it. Reported as "adopted" rather than folded into "created" or "updated",
 * because the distinction is the difference between our copy being live and Apple's
 * defaulted copy of the English being live, and that is worth seeing in the output.
 */
async function upsert(client, { existing, path, type, parent, attributes, listPath, locale }) {
  // `locale` identifies the object rather than describing it, so it is required on create
  // and refused on update. Sending it anyway fails the whole request, which means the same
  // attribute bag cannot be used for both verbs without this line.
  const { locale: _immutable, ...mutable } = attributes;

  if (existing) {
    await client.patch(`${path}/${existing.id}`, {
      data: { type, id: existing.id, attributes: mutable },
    });
    return 'updated';
  }

  try {
    await client.post(path, {
      data: {
        type,
        attributes,
        relationships: { [parent.name]: { data: { type: parent.type, id: parent.id } } },
      },
    });
    return 'created';
  } catch (error) {
    // Matched on Apple's wording rather than the status code, which it returns as 409 for
    // some collections and 422 for others.
    const conflict = (error.errors ?? []).some((e) => /already exists/i.test(e.detail ?? ''));
    if (!conflict || !listPath || !locale) throw error;

    const current = await client.list(listPath);
    const found = current.find((item) => item.attributes.locale === locale);
    if (!found) throw error;

    await client.patch(`${path}/${found.id}`, {
      data: { type, id: found.id, attributes: mutable },
    });
    return 'adopted';
  }
}

module.exports = { upsert };
