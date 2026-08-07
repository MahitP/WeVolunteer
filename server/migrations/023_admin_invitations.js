/**
 * Migration 023: administrator invitations.
 *
 * Implements the storage for §4.3 of the specification (IV-1 … IV-15).
 *
 * ── What an invitation is, and is not ──
 *
 * It is a record that an owner has offered a role to an address. It is NOT an
 * account, a session, or a capability (IV-5), and nothing in this table grants
 * anything: the role is assigned by the acceptance transaction, against a user
 * row that already exists and has proved it controls the address.
 *
 * ── The token is stored hashed ──
 *
 * A pending invitation is administrator authority awaiting collection, which
 * makes this table the highest-value read on the platform. Storing the token
 * itself would mean a database dump — or anybody with `audit.read` and a SQL
 * console — could accept every outstanding invitation. Only a SHA-256 of it is
 * kept, so the plaintext exists in exactly one place: the message sent to the
 * invited address (IV-4).
 *
 * That is also why there is no `UNIQUE` on the raw token and no index that could
 * leak its shape: lookups go through the hash.
 *
 * ── One pending invitation per address (IV-13) ──
 *
 * Enforced by a partial unique index rather than by application logic, because
 * "check then insert" is a race and the failure mode is two live invitations for
 * one address — which makes revocation ambiguous, since revoking one leaves the
 * other usable and the interface cannot say which is authoritative.
 *
 * Scoped to `status = 'pending'` so the history of revoked and accepted
 * invitations for an address is kept rather than overwritten.
 */

export default {
  version: 23,
  name: 'admin_invitations',
  fileUrl: import.meta.url,

  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_invitations (
        id            TEXT PRIMARY KEY,
        /* Stored lower-cased. The address is the identity this invitation is
           bound to (IV-7), so it must compare the same way sign-in does. */
        email         TEXT NOT NULL,
        role          TEXT NOT NULL CHECK(role IN ('admin')),
        /* SHA-256 of the token. Never the token. */
        token_hash    TEXT NOT NULL,
        invited_by    TEXT NOT NULL,
        reason        TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'accepted', 'revoked', 'replaced')),
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        /* Set when the invitation leaves 'pending', whichever way it left. */
        resolved_at   TEXT,
        /* The account that accepted, for the audit trail. Deliberately NOT a
           foreign key: this is a record of an event, and Volume I §1.7.5 is
           explicit that such a record must not be deleted with its subject. */
        accepted_by   TEXT,
        FOREIGN KEY(invited_by) REFERENCES users(id)
      )
    `);

    /**
     * IV-13, enforced by the database.
     *
     * A partial index over `status = 'pending'`: at most one live invitation per
     * address, while every resolved one is kept.
     */
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_invitations_one_pending
        ON admin_invitations(email) WHERE status = 'pending'
    `);

    /* The lookup acceptance performs, on every attempt. */
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_invitations_token
        ON admin_invitations(token_hash)
    `);

    /* The owner-facing pending list (IV-14), newest first. */
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_invitations_status_created
        ON admin_invitations(status, created_at)
    `);
  },
};
