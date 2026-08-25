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

/**
 * `X-Request-Id`, and the thread it starts.
 *
 * The server sets one on every response from its first middleware — including
 * responses produced by middleware that refused the request, which are exactly
 * the ones somebody will later be trying to find. Capturing it here is what lets
 * `reportClientError` send it, and one search in Better Stack then returns the
 * access record and the error record for the same failure.
 */
describe('request correlation', () => {
  const respond = ({ ok = false, status = 500, requestId = null, body = { error: 'Internal server error' } }) => {
    const headers = new Headers();
    if (requestId) headers.set('X-Request-Id', requestId);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok, status, headers, json: () => Promise.resolve(body),
    })));
  };

  const ID = 'b3f1c2d4-0000-4a1b-9c3d-1122334455aa';

  it('puts the server\'s id on the error it throws', async () => {
    respond({ status: 500, requestId: ID });
    await expect(api.apiFetch('/api/events')).rejects.toMatchObject({ requestId: ID });
  });

  it('carries it on a 4xx refusal too, which is where it is most useful', async () => {
    respond({ status: 403, requestId: ID, body: { error: 'Access denied' } });
    await expect(api.apiFetch('/api/events')).rejects.toMatchObject({ status: 403, requestId: ID });
  });

  /**
   * No id means nothing between the browser and the app produced the response —
   * a captive portal, a proxy error page. That is worth knowing: there is no
   * server-side record to go and find.
   */
  it('is null when the response came from something that is not this server', async () => {
    respond({ status: 502, requestId: null });
    await expect(api.apiFetch('/api/events')).rejects.toMatchObject({ requestId: null });
  });

  /**
   * A hostile or unusual `headers.get` must not add a second failure to a path
   * that is already handling one. Asserted with a header bag that throws rather
   * than with one that is absent: `apiFetch` has read `response.headers` since
   * long before correlation existed (the CSV content-type check), so "no headers
   * at all" is not a response this client has ever accepted, and pretending
   * otherwise would be a test written for code that does not exist.
   */
  it('does not add a second failure when reading the header throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 500,
      headers: { get: (name) => { if (name === 'X-Request-Id') throw new Error('boom'); return null; } },
      json: () => Promise.resolve({ error: 'Internal server error' }),
    })));
    await expect(api.apiFetch('/api/events')).rejects.toMatchObject({
      status: 500, requestId: null,
    });
  });

  it('does not send an id of its own — the server assigns them', async () => {
    respond({ ok: true, status: 200, body: {} });
    await api.apiFetch('/api/events');
    const headers = globalThis.fetch.mock.calls[0][1]?.headers ?? {};
    expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('x-request-id');
  });
});
