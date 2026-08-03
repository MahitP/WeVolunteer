/**
 * Step-up on the endpoint that actually emits the archive.
 *
 * ── The hole this closes (v1.2b audit, F-1) ──
 *
 * `POST /api/privacy/export` was gated on `requireAAL2('data.export')`, and the
 * release notes described that as "requesting a data export now requires
 * re-verifying your identity". But the bytes leave through
 * `GET /api/privacy/export/download/:id`, which asked only for a session — and
 * `GET /api/privacy/export/status` hands the job id to any authenticated
 * caller. Archives live seven days (exportWorker.js), so for a week after any
 * legitimate export the complete personal-data archive of a (mostly minor) user
 * was retrievable by anyone holding a borrowed session, with no verification at
 * all. The gate raised the bar only while no archive existed.
 *
 * Gating creation and not retrieval is gating the announcement rather than the
 * disclosure.
 *
 * ── Why a separate action rather than reusing `data.export` ──
 *
 * `data.download` binds `jobId`, so a grant authorises retrieving ONE archive
 * rather than "anything export-shaped". Reusing `data.export` would have made a
 * single grant cover both queuing a new export and pulling an existing one
 * down, which contradicts this module's own rule that a grant proves identity
 * for ONE action — and would have shown the user "export all of your data" in
 * the modal while they were downloading.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startTestServer } from './testServer.js';

const PW = 'Password123';

let srv, db;

beforeAll(async () => {
  process.env.OAUTH_ALLOW_MOCK = 'true';
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => {
  await srv.close();
  delete process.env.OAUTH_ALLOW_MOCK;
});

let seq = 0;
const account = () => {
  seq += 1;
  return {
    email: `exp.dl.${seq}@example.org`, password: PW, name: 'Export Subject',
    role: 'student', grade: '9', school: 'Test High School',
    username: `exp_dl_${seq}`
  };
};

/** Queues an export through the real gated endpoint and completes it. */
async function completedExport(cookie, { expiresInMs = 7 * 24 * 3600 * 1000 } = {}) {
  const header = await srv.verified(cookie, 'data.export', { password: PW });
  const queued = await srv.call('POST', '/api/privacy/export', {}, cookie, header);
  if (queued.status !== 202) throw new Error(`queue failed: ${JSON.stringify(queued.body)}`);
  const jobId = queued.body.jobId;

  const archive = path.join(tmpdir(), `wev-audit-export-${jobId}.zip`);
  writeFileSync(archive, 'PK-ARCHIVE');
  db.prepare(`
    UPDATE data_export_jobs
       SET status = 'completed', file_location = ?, completed_at = ?, expires_at = ?
     WHERE id = ?
  `).run(archive, new Date().toISOString(),
    new Date(Date.now() + expiresInMs).toISOString(), jobId);

  return { jobId, archive };
}

describe('export download: the gate', () => {
  it('refuses a session that has not verified, and names the action to verify', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);

    const res = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('data.download');
  });

  it('allows the download once the archive\'s own grant is presented', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);

    const header = await srv.verified(cookie, 'data.download', { password: PW, params: { jobId } });
    const res = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, header);
    expect(res.status).toBe(200);
  });

  it('does not accept the data.export grant that produced the archive', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);

    // A fresh, valid, unspent grant — for the wrong action.
    const header = await srv.verified(cookie, 'data.export', { password: PW });
    const res = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, header);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('does not accept a grant bound to a different archive', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);

    const header = await srv.verified(cookie, 'data.download', {
      password: PW, params: { jobId: 'export-somebody-elses-job' }
    });
    const res = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, header);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('params_mismatch');
  });

  it('is single use — the same grant cannot pull the archive twice', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);

    const challengeId = await srv.stepUp(cookie, 'data.download', { password: PW, params: { jobId } });
    const header = srv.reauthHeader(challengeId);

    const first = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, header);
    expect(first.status).toBe(200);

    // 403 rather than 409 `consumed`: `requireAAL2` asks `peekChallenge`, which
    // already refuses a spent row, so the early refusal answers before the
    // handler runs. Same shape authz.aal.test.js asserts for a consumed grant.
    const replay = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, header);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('reauth_required');
  });

  it('refuses a grant earned in a different sign-in', async () => {
    const acct = account();
    const { cookie: sessionA } = await srv.signupConfirmed(acct);
    const { jobId } = await completedExport(sessionA);

    // Verified in session A, presented from session B — the stolen-session case.
    const challengeId = await srv.stepUp(sessionA, 'data.download', { password: PW, params: { jobId } });
    const sessionB = await srv.login(acct.email, PW);
    expect(sessionB).not.toBe(sessionA);

    const res = await srv.call(
      'GET', `/api/privacy/export/download/${jobId}`, undefined, sessionB, srv.reauthHeader(challengeId)
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('never lets one account spend a grant on another account\'s archive', async () => {
    const { cookie: victim } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(victim);

    const { cookie: stranger } = await srv.signupConfirmed(account());
    const header = await srv.verified(stranger, 'data.download', { password: PW, params: { jobId } });

    // 404, not 403: a foreign job is answered exactly like a missing one, so
    // the existence oracle privacyExportIdor.test.js closed stays closed.
    const res = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, stranger, header);
    expect(res.status).toBe(404);
  });
});

describe('export download: a refused request must not cost the verification', () => {
  it('keeps the grant spendable when the archive has expired', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie, { expiresInMs: -1000 });

    const challengeId = await srv.stepUp(cookie, 'data.download', { password: PW, params: { jobId } });
    const header = srv.reauthHeader(challengeId);

    const expired = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, header);
    expect(expired.status).toBe(410);

    // The grant was not burned by a request that delivered nothing.
    const row = db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(challengeId);
    expect(row.consumed_at).toBeNull();
  });

  it('keeps the grant spendable when the archive file is missing from disk', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);
    db.prepare('UPDATE data_export_jobs SET file_location = ? WHERE id = ?')
      .run(path.join(tmpdir(), 'wev-audit-does-not-exist.zip'), jobId);

    const challengeId = await srv.stepUp(cookie, 'data.download', { password: PW, params: { jobId } });
    const gone = await srv.call(
      'GET', `/api/privacy/export/download/${jobId}`, undefined, cookie, srv.reauthHeader(challengeId)
    );
    expect(gone.status).toBe(404);

    const row = db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(challengeId);
    expect(row.consumed_at).toBeNull();
  });
});

describe('export status: unchanged, and now harmless on its own', () => {
  it('still answers an ordinary authenticated request', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const { jobId } = await completedExport(cookie);

    const res = await srv.call('GET', '/api/privacy/export/status', undefined, cookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(jobId);
  });

  it('never reveals another account\'s job', async () => {
    const { cookie: owner } = await srv.signupConfirmed(account());
    await completedExport(owner);

    const { cookie: stranger } = await srv.signupConfirmed(account());
    const res = await srv.call('GET', '/api/privacy/export/status', undefined, stranger);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('none');
  });
});

describe('export creation: the existing gate is unchanged', () => {
  it('still refuses an unverified request', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const res = await srv.call('POST', '/api/privacy/export', {}, cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('data.export');
  });

  it('still accepts a verified one', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const header = await srv.verified(cookie, 'data.export', { password: PW });
    const res = await srv.call('POST', '/api/privacy/export', {}, cookie, header);
    expect(res.status).toBe(202);
  });
});
