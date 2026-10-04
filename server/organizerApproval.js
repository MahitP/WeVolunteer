/**
 * Queries behind taking an organizer's approval back and giving it again
 * (P2-12), taking a database handle rather than importing the global — the
 * shape `db.accessSurface.test.js` ratchets towards. The rules are written
 * above the routes in `routes/adminRoutes.js`.
 */

/** Whether an organizer has any event on record — what makes a delete unsafe. */
export async function hasEventsOnRecord(db, organizerId) {
  return Boolean(await db.prepare('SELECT 1 FROM events WHERE organizer_id = ? LIMIT 1').get(organizerId));
}

/** An organizer who currently holds approval, or null. */
export async function approvedOrganizer(db, id) {
  return (await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'organizer' AND verified = 1").get(String(id))) || null;
}

/** Organizers who hold or held approval, with their event counts. */
export async function organizersWithApproval(db) {
  const rows = await db.prepare(`
    SELECT u.id, u.name, u.email, u.school, u.verified, u.approval_revoked_at,
           (SELECT COUNT(*) FROM events e WHERE e.organizer_id = u.id) AS events
      FROM users u
     WHERE u.role = 'organizer' AND u.account_status = 'active'
       AND (u.verified = 1 OR u.approval_revoked_at IS NOT NULL)
     ORDER BY u.name COLLATE nocase
     LIMIT 500
  `).all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    school: r.school || null,
    events: Number(r.events) || 0,
    status: r.verified === 1 ? 'approved' : 'revoked',
    revokedAt: r.approval_revoked_at || null,
  }));
}
