import { ALL_CAPABILITIES, SUPER_ONLY } from './authz.js';

const SUPER_ONLY_SET = new Set(SUPER_ONLY);

export function grantCapability({ db, userId, capability, scope = '', grantedBy, expiresAt = null }) {
  if (!ALL_CAPABILITIES.includes(capability)) {
    throw new Error(`Unknown capability: ${capability}`);
  }
  // capability.grant lets an admin hand out capabilities; without this refusal
  // an admin could grant themselves (or anyone) a super_admin-only capability
  // such as impersonation.start, turning capability.grant into a path to root.
  if (SUPER_ONLY_SET.has(capability)) {
    throw new Error(`Capability ${capability} cannot be granted — it is super_admin only`);
  }
  db.prepare(`
    INSERT INTO user_capabilities (user_id, capability, scope, granted_by, granted_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, capability, scope) DO UPDATE SET
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at,
      expires_at = excluded.expires_at
  `).run(userId, capability, scope, grantedBy, new Date().toISOString(), expiresAt);
}

export function revokeCapability({ db, userId, capability, scope = '' }) {
  db.prepare('DELETE FROM user_capabilities WHERE user_id = ? AND capability = ? AND scope = ?')
    .run(userId, capability, scope);
}

/** Unexpired capabilities held by this user, for `principalFor()`. */
export function grantsFor(db, userId) {
  return db.prepare(`
    SELECT DISTINCT capability FROM user_capabilities
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
  `).all(userId, new Date().toISOString()).map(r => r.capability);
}
