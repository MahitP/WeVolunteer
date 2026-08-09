/**
 * Client mirror of the server's tag rules.
 *
 * Re-exported from the server module rather than copied, for the reason
 * `src/authz.js` and `src/moderation.js` both give: two copies of a rule drift,
 * and the direction they drift in is "the UI offers something the API rejects".
 *
 * That is especially easy to get wrong here, because the rule is a regex and a
 * pair of limits. A client that permitted 40 characters against a server that
 * permits 30 would let an organizer type a tag, see it accepted as a chip, press
 * Save, and get a 400 naming a field they cannot see — after which their only
 * option is to guess which tag was too long.
 *
 * `server/eventTags.js` imports nothing at all — no db, no config — which is what
 * makes this safe: importing it into the browser bundle pulls in a pure module,
 * not a database connection. Keep it that way. The read/write helpers in that file
 * do take a `db` handle, and they are deliberately NOT re-exported here: a client
 * has no database, and exporting them would put dead code in the bundle and invite
 * somebody to try.
 *
 * Client-side validation is a courtesy that tells the organizer immediately.
 * `POST`/`PUT /api/events` validate every tag again — see the note there.
 */
export { normaliseTag, MAX_TAGS_PER_EVENT, MAX_TAG_LENGTH } from '../server/eventTags.js';
