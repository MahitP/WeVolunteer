import { encryptSecret } from '../cryptoUtils.js';

export default {
  version: 27,
  name: 'encrypt_tfa_secrets',
  fileUrl: import.meta.url,
  up(db) {
    // 1. Identify existing plaintext TOTP secrets (those without 'v1:' prefix)
    const usersWithPlaintextSecrets = db.prepare(`
      SELECT id, tfa_secret 
      FROM users 
      WHERE tfa_secret IS NOT NULL 
        AND tfa_secret NOT LIKE 'v1:%'
    `).all();

    if (usersWithPlaintextSecrets.length === 0) {
      return; // Nothing to migrate
    }

    // 2. Encrypt and update them. This is done securely using the application's
    // crypto utility without logging the secrets.
    const updateStmt = db.prepare(`
      UPDATE users 
      SET tfa_secret = ? 
      WHERE id = ?
    `);

    // Run inside the migration transaction
    for (const row of usersWithPlaintextSecrets) {
      try {
        const encrypted = encryptSecret(row.tfa_secret);
        updateStmt.run(encrypted, row.id);
      } catch (err) {
        // Do not include secrets in migration error messages
        throw new Error(`Failed to encrypt TOTP secret for user ID: ${row.id}`);
      }
    }
  }
};
