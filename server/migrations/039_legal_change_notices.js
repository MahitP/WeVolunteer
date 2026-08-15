/**
 * Who has been told that a legal document changed, and who has read it.
 *
 * ── Why this is not `legal_acceptances` ──
 *
 * The temptation is to write a row into `legal_acceptances` with
 * `method = 'notice'`. That table is the consent record: it is what the product
 * would produce if somebody ever asked "prove this person agreed". Putting
 * "saw a popup" rows in it would mean every future reader of that table has to
 * know which methods are consent and which are not, and the first one who
 * forgets turns a dismissed modal into evidence of agreement.
 *
 * Acknowledging a notice is emphatically NOT consent. It is "I have seen that
 * this changed". Two different facts, two different tables.
 *
 * ── Why a table at all, when notifications already dedupe ──
 *
 * `notifications.dedupe_key` has a UNIQUE index, so dispatching with a key of
 * `legal:<slug>:<version>` already guarantees one notification and one email
 * per user per version, permanently. That solves delivery.
 *
 * It does not solve the popup. "Show this until they dismiss it" is a different
 * question from "have we sent this", and answering it from the notifications
 * table would mean a user who deletes a notification starts seeing the modal
 * again forever. This table answers exactly one question — has this user
 * dismissed the notice for this version — and nothing else.
 *
 * ── Shape ──
 *
 * `(user_id, slug, version)` is the primary key, so acknowledging twice is a
 * no-op rather than a duplicate, and a retry cannot produce two rows.
 *
 * `notified_at` is nullable and separate from `acknowledged_at` because the two
 * events are genuinely independent: the sweep records that it told somebody, the
 * user records that they read it, and either can happen without the other (a
 * user who visits before the sweep runs sees the modal from the version
 * comparison, not from a notification).
 *
 * ON DELETE CASCADE on the user: this is a record about a live relationship, not
 * history worth keeping past the account. Consent records are the opposite and
 * are deliberately `ON DELETE RESTRICT` in 007.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_change_notices (
      user_id         TEXT NOT NULL,
      slug            TEXT NOT NULL,
      version         TEXT NOT NULL,
      notified_at     TEXT,
      acknowledged_at TEXT,
      PRIMARY KEY (user_id, slug, version),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  /**
   * The read path is "everything this user has not yet acknowledged", which is
   * a scan of one user's rows. The primary key already leads on `user_id`, so
   * that is a covering index search and no second index is needed — the same
   * reasoning that made an index unnecessary for `user_badges(user_id)`.
   */
}

export default {
  version: 39,
  name: 'legal_change_notices',
  up,
  fileUrl: import.meta.url,
};
