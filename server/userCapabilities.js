import { ALL_CAPABILITIES, SUPER_ONLY } from './authz.js';

const SUPER_ONLY_SET = new Set(SUPER_ONLY);

export async function grantCapability({ db, userId, capability, scope = '', grantedBy, expiresAt = null }) {
  if (!ALL_CAPABILITIES.includes(capability)) {
    throw new Error(`Unknown capability: ${capability}`);
  }
  // Refuse scoped grants outright rather than writing a row the kernel cannot
  // honour. `can(principal, capability)` takes no scope argument, so every
  // grant it sees is evaluated platform-wide — a row written as
  // {capability: 'event.moderate', scope: 'event-123'} would have become a
  // GLOBAL event.moderate, i.e. the "may act on any event" bypass in all 20
  // ownership checks on this branch. `grantsFor` now filters to scope = ''
  // so such a row could never be read back, but a write that silently does
  // nothing is its own trap: an admin would see the grant recorded, and the
  // holder would report it not working. Fail at the point of the mistake.
  if (scope !== '') {
    throw new Error(
      `Scoped capability grants are not enforced: refusing to grant ${capability} `
      + `with scope '${scope}'. can() takes no scope argument, so a stored scope is `
      + 'ignored at decision time — the grant would act platform-wide or not at all. '
      + 'Pass no scope (global) until can() accepts one.'
    );
  }
  // capability.grant lets an admin hand out capabilities; without this refusal
  // an admin could grant themselves (or anyone) a super_admin-only capability
  // such as impersonation.start, turning capability.grant into a path to root.
  if (SUPER_ONLY_SET.has(capability)) {
    throw new Error(`Capability ${capability} cannot be granted — it is super_admin only`);
  }
  await db.prepare(`
    INSERT INTO user_capabilities (user_id, capability, scope, granted_by, granted_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, capability, scope) DO UPDATE SET
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at,
      expires_at = excluded.expires_at
  `).run(userId, capability, scope, grantedBy, new Date().toISOString(), expiresAt);
}

export async function revokeCapability({ db, userId, capability, scope = '' }) {
  await db.prepare('DELETE FROM user_capabilities WHERE user_id = ? AND capability = ? AND scope = ?')
    .run(userId, capability, scope);
}

/**
 * Unexpired GLOBAL capabilities held by this user, for `principalFor()`.
 *
 * `AND scope = ''` is load-bearing, not a tidy-up. The schema documents scope
 * as "'' = global; else school/event id" (migrations/002_user_capabilities.js),
 * and scope is part of the primary key — but the principal these rows feed is
 * consumed by `can(principal, capability)`, which has no scope parameter and
 * therefore cannot narrow anything. Without this predicate a row scoped to one
 * event would be returned as a plain capability string and enforced everywhere:
 * a grant of `event.moderate` scoped to 'event-123' would satisfy the
 * `!can(principal, 'event.moderate')` bypass in every ownership check on the
 * platform. Reading only global rows keeps the kernel's behaviour equal to what
 * it can actually express. `grantCapability` refuses to write a scoped row for
 * the same reason, so today this predicate defends against rows inserted by
 * hand or by a future scope-aware writer that lands before a scope-aware
 * `can()`.
 */
export async function grantsFor(db, userId) {
  return (await db.prepare(`
    SELECT DISTINCT capability FROM user_capabilities
    WHERE user_id = ? AND scope = '' AND (expires_at IS NULL OR expires_at > ?)
  `).all(userId, new Date().toISOString())).map(r => r.capability);
}
