import crypto from 'crypto';

/**
 * Valid event types for the security audit log.
 */
const VALID_EVENT_TYPES = Object.freeze([
  '2FA_TOTP_ENABLED',
  '2FA_TOTP_DISABLED',
  '2FA_EMAIL_ENABLED',
  '2FA_EMAIL_DISABLED',
  '2FA_RECOVERY_GENERATED',
  '2FA_SUCCESS',
  '2FA_FAILED',
  '2FA_THROTTLED',
  '2FA_RECOVERY_USED',
]);

/**
 * Writes a security audit event.
 * 
 * Used exclusively for user security lifecycle events, separate from 
 * administrative actions.
 * 
 * @param {object} db - an open database handle
 * @param {object} req - the Express request object (to extract IP and UA)
 * @param {string} userId - the user ID the event is about
 * @param {string} eventType - the action type
 * @param {object} metadata - optional JSON metadata (do NOT put secrets here)
 */
export function recordSecurityEvent(db, req, userId, eventType, metadata = null) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('recordSecurityEvent: database handle required');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('recordSecurityEvent: userId is required');
  }
  if (!VALID_EVENT_TYPES.includes(eventType)) {
    throw new Error(`recordSecurityEvent: invalid eventType '${eventType}'`);
  }

  const id = `sec-${crypto.randomUUID()}`;
  const ipAddress = req.ip || req.connection?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;
  const metadataStr = metadata ? JSON.stringify(metadata) : null;
  const createdAt = new Date().toISOString();

  // Strip anything that looks like a secret if someone accidentally passes it
  if (metadataStr && (metadataStr.toLowerCase().includes('secret') || metadataStr.toLowerCase().includes('password') || metadataStr.toLowerCase().includes('code'))) {
     throw new Error('recordSecurityEvent: metadata appears to contain sensitive fields');
  }

  db.prepare(`
    INSERT INTO security_audit_logs (id, user_id, event_type, ip_address, user_agent, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, eventType, ipAddress, userAgent, metadataStr, createdAt);
}
