/**
 * Give `moderation_actions` somewhere to keep a withdrawn decision's words.
 *
 * ── The data loss this closes ──
 *
 * Reopening a report clears `resolution`, `resolution_note`, `resolved_by` and
 * `resolved_at` from the `reports` row, which is right — a reopened report that
 * still reads as resolved by a named person at a named time is a lie the next
 * moderator acts on.
 *
 * The handler's comment said the withdrawn decision was safe because it lived in
 * `moderation_actions`. It did not. That table records `old_resolution` and
 * `new_resolution` — the enum WORD, `warning_issued` or `no_action` — and has no
 * column for text at all. So the resolution NOTE was destroyed on reopen.
 *
 * That note is the moderator's account of what they decided and why.
 * `ResolutionModal.jsx` tells the moderator writing it that it is "kept
 * permanently and… what an appeal is reviewed against". So a student appealing a
 * decision that had been reopened once was appealing against nothing: the
 * reviewer opened the case and found the reasoning gone, with the interface still
 * promising it was there.
 *
 * ── Why a column here rather than on `reports` ──
 *
 * Because a report can be reopened more than once, and `reports` holds ONE
 * decision. A second `previous_resolution_note` column would lose the first
 * withdrawal the moment there was a second. The history table already has a row
 * per action; the note belongs on the row that withdrew it.
 *
 * `moderation_actions` is also retention-exempt (`PRESERVED_TABLES` in
 * `retentionWorker.js`), which the audit trail is not — so this is the one place
 * that keeps a superseded decision for as long as the appeal it might be reviewed
 * against.
 *
 * ── Additive only ──
 *
 * One nullable column. Every existing row keeps a NULL note, which is honest:
 * those withdrawals really did happen without one being recorded, and inventing
 * text for them would be worse than the gap.
 */
export default {
  version: 28,
  name: 'moderation_action_note',
  fileUrl: import.meta.url,

  up(db) {
    const columns = new Set(
      db.prepare('PRAGMA table_info(moderation_actions)').all().map((c) => c.name),
    );

    if (!columns.has('note')) {
      db.exec('ALTER TABLE moderation_actions ADD COLUMN note TEXT');
    }
  },
};
