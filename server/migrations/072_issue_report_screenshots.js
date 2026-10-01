/**
 * Screenshots on a problem report (FX-75).
 *
 * The owner asked for a report page that can "include screenshots". A
 * screenshot of somebody's screen is likely to hold their personal data and
 * other people's, so these are stored here — in the database, with its
 * backups and its access rules — and never under `/uploads`, which nginx
 * serves to anybody who has the address.
 *
 * `data` is the image AFTER the route has decoded and re-encoded it, as
 * base64: the re-encode is what drops a photo's EXIF (where it was taken)
 * and what refuses a file that only claims to be an image. Base64 in TEXT
 * rather than a binary column so the same statement works on SQLite and
 * PostgreSQL through the one dialect layer; at three images of a few hundred
 * kilobytes per report, the third of extra size does not matter.
 *
 * `position` is 1, 2 or 3, and with `issue_id` it is the key — a fourth
 * cannot be inserted however the route is reached. The images go with their
 * report when it is deleted.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_report_screenshots (
      issue_id    TEXT NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL CHECK(position BETWEEN 1 AND 3),
      mime_type   TEXT NOT NULL,
      data        TEXT NOT NULL,
      bytes       INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (issue_id, position)
    )
  `);
}

async function postgresUp(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS issue_report_screenshots (
      issue_id    text NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
      position    integer NOT NULL CHECK(position BETWEEN 1 AND 3),
      mime_type   text NOT NULL,
      data        text NOT NULL,
      bytes       integer NOT NULL,
      created_at  text NOT NULL,
      PRIMARY KEY (issue_id, position)
    );
  `);
}

export default {
  version: 72,
  name: 'issue_report_screenshots',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
