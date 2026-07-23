import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

/**
 * Production must refuse to boot without SMTP (P1-F).
 *
 * The email module installs a console mock when SMTP is unconfigured. That is a
 * development convenience; in production it would print password-reset and
 * verification tokens to the log and deliver nothing. email.js runs its check
 * at import time, so importing it under each configuration is enough to observe
 * the boot decision. Each case runs in its own subprocess for a clean module
 * state.
 */
function importEmail(env) {
  const root = process.cwd().replace(/\\/g, '/');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      await import('${root}/server/email.js');
      console.log('IMPORT_OK');
    `], {
      cwd: process.cwd(),
      // Start from a clean SMTP slate so the host's own env cannot leak in.
      env: { ...process.env, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', NODE_ENV: '', ...env },
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

describe('email transport boot policy (P1-F)', () => {
  it('exits non-zero in production when SMTP is not configured', () => {
    const r = importEmail({ NODE_ENV: 'production' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/SMTP is not configured/i);
    expect(r.out).not.toContain('IMPORT_OK');
  });

  it('boots in production when SMTP is fully configured', () => {
    const r = importEmail({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASS: 'p'
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('IMPORT_OK');
  });

  it('still uses the console mock outside production', () => {
    const r = importEmail({}); // NODE_ENV unset, no SMTP
    expect(r.code).toBe(0);
    expect(r.out).toContain('IMPORT_OK');
    expect(r.out).toMatch(/mock mode/i);
  });
});
