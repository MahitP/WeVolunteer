/**
 * `api.downloadExport` has to fail in exactly the shape `withStepUp` reads.
 *
 * ── Why this is worth its own file (v1.2b audit, F-1) ──
 *
 * `withStepUp` does not ask permission first. It calls the attempt bare, and
 * only opens a verification when the refusal it catches satisfies
 * `needsStepUp(err)` — `err.status === 403 && err.data.code === 'reauth_required'`.
 *
 * Every other sensitive call goes through `apiFetch`, which builds that shape.
 * The export download cannot: a zip is not JSON, and this endpoint answers its
 * refusals in two different content types — JSON for the step-up 403, plain
 * text for "Export has expired" and "not ready". So it has a hand-written error
 * path, and if that path forgets to parse the body, `err.data` is null,
 * `needsStepUp` is false, and the failure mode is silent and total: the
 * verification dialog never opens and the user is shown a permanent
 * "Identity verification required" toast for an action they are entitled to
 * perform and given no way to perform.
 *
 * That is not reachable by the server suite — it is a client contract — and it
 * would not fail any existing test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from './api';
import { needsStepUp, actionFromError, STEP_UP } from './stepUp';

const respondWith = ({ ok = false, status = 403, body = '', type = 'application/json' }) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok,
    status,
    headers: new Headers({ 'content-type': type }),
    text: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([body])),
  })));
};

afterEach(() => vi.restoreAllMocks());

describe('api.downloadExport', () => {
  it('throws an error withStepUp recognises when the server asks for verification', async () => {
    respondWith({
      status: 403,
      body: JSON.stringify({
        error: 'Identity verification required',
        code: 'reauth_required',
        action: 'data.download'
      })
    });

    const err = await api.downloadExport('export-1').catch(e => e);

    // The two properties the retry loop actually branches on.
    expect(needsStepUp(err)).toBe(true);
    expect(actionFromError(err)).toBe(STEP_UP.DATA_DOWNLOAD);
  });

  it('sends the challenge header it is given', async () => {
    respondWith({ ok: true, status: 200, body: 'zip', type: 'application/zip' });

    await api.downloadExport('export-2', { 'X-Reauth-Challenge': 'reauth-abc' });

    expect(fetch).toHaveBeenCalledWith(
      '/api/privacy/export/download/export-2',
      expect.objectContaining({
        credentials: 'include',
        headers: { 'X-Reauth-Challenge': 'reauth-abc' }
      })
    );
  });

  it('returns the archive as a blob on success', async () => {
    respondWith({ ok: true, status: 200, body: 'PK-ARCHIVE', type: 'application/zip' });
    const blob = await api.downloadExport('export-3');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('surfaces a plain-text refusal as its message rather than swallowing it', async () => {
    // 410 arrives as text/plain, so JSON.parse fails — the body must still
    // reach the user instead of becoming "Unexpected token E in JSON".
    respondWith({ status: 410, body: 'Export has expired', type: 'text/plain' });

    const err = await api.downloadExport('export-4').catch(e => e);

    expect(err.status).toBe(410);
    expect(err.message).toBe('Export has expired');
    // Not a step-up refusal, so the caller must rethrow rather than open a dialog.
    expect(needsStepUp(err)).toBe(false);
  });

  it('escapes the job id rather than pasting it into the path', async () => {
    respondWith({ ok: true, status: 200, body: 'zip', type: 'application/zip' });
    await api.downloadExport('a/../b');
    expect(fetch).toHaveBeenCalledWith('/api/privacy/export/download/a%2F..%2Fb', expect.anything());
  });
});
