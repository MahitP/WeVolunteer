/**
 * Where a persona preview lives.
 *
 * ── What the feature is ──
 *
 * The platform owner sees a version of this application almost nobody else does:
 * every rail entry, every administrative surface, every capability. That makes
 * the owner the worst-placed person to notice that a student's view is broken —
 * which is a real problem for a product whose primary audience is students.
 *
 * A preview lets the owner look at the application as a plain member of another
 * role, so the thing they are checking is the thing students actually get.
 *
 * ── Why it is server state, and on the USER row ──
 *
 * The obvious implementation is a client flag, and it is the wrong one twice
 * over. It would be a lie — the server would still answer every request with the
 * owner's real capabilities, so the preview would show a student's navigation
 * over an administrator's data — and it would be a role switch living in
 * client-controlled storage, which is the shape of a privilege-escalation bug
 * even when it happens to be implemented safely.
 *
 * So it is server state. On `users` rather than in a table of its own because
 * `authenticateToken` already reads that row on every authenticated request:
 * two more columns on a query that is happening anyway cost nothing, and a
 * separate table would add an indexed lookup to every API call in the
 * application for a feature one account uses.
 *
 * That query is an explicit column list rather than `SELECT *`, so both columns
 * had to be named in it. They were not, at first, and the result was a preview
 * that wrote correctly, resolved correctly in `buildPrincipal`, and had no effect
 * whatsoever on a real request — with the unit tests green, because those build a
 * principal from a row fetched with `SELECT *`.
 *
 * Per ACCOUNT, not per session, and that is deliberate rather than a limitation.
 * The owner is one person; a preview that applied to the tab it was started in
 * and not to the one they had open beside it would be a confusing way to be
 * shown two different answers to the same question.
 *
 * ── Why it expires ──
 *
 * A preview REMOVES capabilities — see the narrowing rule in `authz.js`. A stale
 * one is therefore an owner who has quietly lost their administrative access and
 * has no reason to connect that to something they clicked yesterday. The expiry
 * is the backstop for a browser closed mid-preview; `persona.preview.exit` is
 * held by every role precisely so the ordinary way out is always available from
 * inside the preview.
 *
 * ── Additive only ──
 *
 * Two nullable columns. NULL in either means no preview is in force, and
 * `buildPrincipal` requires BOTH to be present and unexpired before it will
 * narrow anything — a half-written pair resolves to the real role, which is the
 * safe direction for a field whose only power is to take capabilities away.
 *
 * A migration rather than `addColumnIfMissing` for the reason 029 documents at
 * length: that pass runs BEFORE the registry, and `001_authz_roles` rebuilds
 * `users` from an explicit column list with an unknown-column guard, so a column
 * present at that moment stops the boot.
 */
export default {
  version: 30,
  name: 'persona_preview',
  fileUrl: import.meta.url,

  up(db) {
    const columns = new Set(
      db.prepare('PRAGMA table_info(users)').all().map((c) => c.name),
    );

    if (!columns.has('preview_persona')) {
      db.exec('ALTER TABLE users ADD COLUMN preview_persona TEXT');
    }
    if (!columns.has('preview_expires_at')) {
      db.exec('ALTER TABLE users ADD COLUMN preview_expires_at TEXT');
    }
  },
};
