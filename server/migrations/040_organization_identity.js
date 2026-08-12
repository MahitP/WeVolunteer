/**
 * A face for an organization.
 *
 * ── Two columns, mirroring `users` exactly ──
 *
 * `users` has carried this shape for a long time: `avatar` holds an emoji,
 * `profile_picture_url` holds an uploaded file, and the renderer prefers the
 * upload and falls back to the emoji. Organizations get the same two columns
 * with the same names-by-analogy, because a second convention for "what picture
 * goes here" would mean every avatar component has to learn which kind of thing
 * it was handed.
 *
 * An emoji is not a lesser option here. A school club that wants 🍎 gets a
 * recognisable mark in one tap, with no upload, no moderation surface, no file
 * on disk to serve or delete, and nothing that can be a photograph of a child.
 * For most organizations it is the better answer, which is why it is the one
 * with a default.
 *
 * ── Why `image_url` rather than reusing an uploads table ──
 *
 * There is no uploads table; `users.profile_picture_url` is a plain relative URL
 * under `public/uploads/`, written by `profilePictureRoutes.js`, which owns the
 * only delete path in the application. Organization images join that same
 * directory and that same deleter rather than inventing a parallel one.
 *
 * ── Nullable, no backfill ──
 *
 * Every existing organization keeps rendering exactly as it does today: the
 * client already falls back to an initial when there is no picture, so an
 * absent value is a supported state rather than a migration to run.
 */

function up(db) {
  const columns = db.prepare('PRAGMA table_info(organizations)').all().map(c => c.name);

  /* Guarded individually rather than as a pair: a half-applied earlier run
     would otherwise be unrecoverable, and ALTER TABLE ADD COLUMN cannot be
     wrapped in IF NOT EXISTS. */
  if (!columns.includes('avatar')) {
    db.exec("ALTER TABLE organizations ADD COLUMN avatar TEXT");
  }
  if (!columns.includes('image_url')) {
    db.exec('ALTER TABLE organizations ADD COLUMN image_url TEXT');
  }
  if (!columns.includes('image_uploaded_at')) {
    db.exec('ALTER TABLE organizations ADD COLUMN image_uploaded_at TEXT');
  }
}

export default {
  version: 40,
  name: 'organization_identity',
  up,
  fileUrl: import.meta.url,
};
