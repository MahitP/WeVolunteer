/**
 * The screenshot rows behind a problem report (FX-75), as functions that take a
 * database handle rather than importing the global one — the shape
 * `db.accessSurface.test.js` ratchets the codebase towards, so the PostgreSQL
 * port can hand these a pooled client. The rules they serve are written above
 * the routes in `routes/issueRoutes.js`.
 */

/** The report a reporter may attach to, or null — for anybody else, the same null. */
export async function reportForAttaching(db, reference, userId) {
  const issue = await db.prepare('SELECT id, reporter_id, created_at FROM issue_reports WHERE reference = ?')
    .get(String(reference || ''));
  return issue && issue.reporter_id === userId ? issue : null;
}

export async function countScreenshots(db, issueId) {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM issue_report_screenshots WHERE issue_id = ?').get(issueId);
  return Number(n) || 0;
}

/** Stores one re-encoded image. Throws if the position is already taken. */
export async function storeScreenshot(db, { issueId, position, mimeType, bytes }) {
  await db.prepare(`
    INSERT INTO issue_report_screenshots (issue_id, position, mime_type, data, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(issueId, position, mimeType, bytes.toString('base64'), bytes.length, new Date().toISOString());
}

/** `{ mimeType, bytes }`, or null. */
export async function readScreenshot(db, issueId, position) {
  const row = await db.prepare(
    'SELECT mime_type, data FROM issue_report_screenshots WHERE issue_id = ? AND position = ?'
  ).get(String(issueId), Number(position) || 0);
  return row ? { mimeType: row.mime_type, bytes: Buffer.from(row.data, 'base64') } : null;
}
