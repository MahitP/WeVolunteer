import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('API Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Headers()
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends credentials: include on all requests by default', async () => {
    await api.apiFetch('/api/admin/organizers/pending');
    expect(fetch).toHaveBeenCalledWith('/api/admin/organizers/pending', expect.objectContaining({
      credentials: 'include'
    }));
  });
  
  it('does not send Authorization headers', async () => {
    await api.apiFetch('/api/admin/organizers/pending');
    expect(fetch).toHaveBeenCalledWith('/api/admin/organizers/pending', expect.objectContaining({
      headers: {
        'Content-Type': 'application/json'
      }
    }));
    const callArgs = fetch.mock.calls[0][1];
    expect(callArgs.headers['Authorization']).toBeUndefined();
  });
});

/**
 * A 2xx that does not carry JSON must be reported, not returned as `null`.
 *
 * ── The crash these defend ──
 *
 * `apiFetch` swallowed a JSON parse failure and returned `null` on any 2xx, so
 * a proxy answering `200 text/html` looked to every caller like a successful
 * empty response. `AdminDashboard` then rendered `events.filter(...)` against
 * null and took its whole screen down through the error boundary — reproduced
 * in an extreme-usage run as "Cannot read properties of null (reading
 * 'filter')". Nothing on the server can produce it; a captive portal, CDN
 * error page or ISP interception page on the wire can, and does.
 *
 * The contract these fix in place: a caller gets parsed JSON, or an error it
 * already knows how to handle. Never a silent null.
 */
describe('a 2xx response that is not JSON', () => {
  const respond = ({ status = 200, body, contentType = 'text/html' }) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': contentType }),
      json: () => body === undefined
        ? Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0'))
        : Promise.resolve(body),
    })));
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it('is rejected rather than resolved as null', async () => {
    respond({ status: 200 });
    await expect(api.apiFetch('/api/admin/organizers/pending')).rejects.toThrow(/could not read/i);
  });

  it('is reported as a network error, so callers treat it as an outage', async () => {
    respond({ status: 200 });
    await expect(api.apiFetch('/api/admin/organizers/pending')).rejects.toMatchObject({ isNetworkError: true, status: 200 });
  });

  it('still rejects when the proxy answers 201', async () => {
    respond({ status: 201 });
    await expect(api.apiFetch('/api/admin/organizers/pending')).rejects.toThrow(/could not read/i);
  });

  /* No content is the one status for which an unreadable body is correct. */
  it('allows 204 through as null', async () => {
    respond({ status: 204 });
    await expect(api.apiFetch('/api/admin/organizers/pending')).resolves.toBeNull();
  });

  it('leaves an ordinary JSON response untouched', async () => {
    respond({ status: 200, body: { id: 'user-1' }, contentType: 'application/json' });
    await expect(api.apiFetch('/api/admin/organizers/pending')).resolves.toEqual({ id: 'user-1' });
  });

  /* A non-JSON body on a FAILURE still reports the status, as it always did —
     the status check runs first and this change must not disturb it. */
  it('still reports the status when a failure carries a non-JSON body', async () => {
    respond({ status: 502 });
    await expect(api.apiFetch('/api/admin/organizers/pending')).rejects.toMatchObject({ status: 502 });
  });
});
