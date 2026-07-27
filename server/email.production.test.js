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
      // Start from a clean slate so the host's own env cannot leak in.
      env: { ...process.env, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', NODE_ENV: '', APP_URL: '', ...env },
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

  it('boots in production when SMTP and APP_URL are fully configured', () => {
    const r = importEmail({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASS: 'p',
      APP_URL: 'https://volunteers.example.org'
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('IMPORT_OK');
  });
});

/**
 * APP_URL must be explicit in production.
 *
 * It used to fall back to a hardcoded public domain. A deployment that forgot
 * it booted cleanly and kept sending mail, but every password-reset link
 * carried a live single-use token to a host the operator did not control.
 * Nothing failed and nothing logged — the only symptom was users saying reset
 * links "don't work". That is exactly the class of silent failure the other
 * production guards exist to prevent, so it now behaves the same way.
 */
describe('APP_URL boot policy', () => {
  it('exits non-zero in production when APP_URL is not set', () => {
    const r = importEmail({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASS: 'p'
      // APP_URL deliberately absent
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/APP_URL must be set in production/i);
    expect(r.out).not.toContain('IMPORT_OK');
  });

  it('does not require APP_URL outside production', () => {
    const r = importEmail({}); // no NODE_ENV, no APP_URL
    expect(r.code).toBe(0);
    expect(r.out).toContain('IMPORT_OK');
  });

  it('reports SMTP first when both SMTP and APP_URL are missing', () => {
    // Order is load-bearing for the runbook: an operator fixes SMTP, then
    // APP_URL. If this flips, the documented sequence is wrong.
    const r = importEmail({ NODE_ENV: 'production' });
    expect(r.out).toMatch(/SMTP is not configured/i);
    expect(r.out).not.toMatch(/APP_URL must be set/i);
  });

  it('still uses the console mock outside production', () => {
    const r = importEmail({}); // NODE_ENV unset, no SMTP
    expect(r.code).toBe(0);
    expect(r.out).toContain('IMPORT_OK');
    expect(r.out).toMatch(/mock mode/i);
  });
});
