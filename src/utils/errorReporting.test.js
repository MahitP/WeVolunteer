/**
 * Client crash reporting, and the four ways it can make things worse.
 *
 * ── Why this file is mostly about NOT reporting ──
 *
 * A reporter that fires on every failure is not a feature, it is an outage
 * amplifier. Everything here exists because the naive version has a specific,
 * known way of turning one bad afternoon into a much worse one:
 *
 *   1. Reporting the reporter. `POST /api/errors/report` fails, that failure is
 *      an error, which is reported, which fails. It never stops, and it does it
 *      at network speed from every open tab.
 *   2. A render loop. React re-renders a throwing tree many times a second, and
 *      each pass is a fresh `componentDidCatch`. One broken component becomes
 *      thousands of identical rows.
 *   3. Offline. Everyone on the school bus loses their connection at the same
 *      place every day. Those are not defects, and they would bury the ones
 *      that are.
 *   4. Throwing. A reporter that throws inside an error boundary turns a caught
 *      error into an uncaught one — it breaks the exact recovery it was added
 *      to observe.
 *
 * The server has its own defences (a rate limiter, an 8 kB cap, a client-group
 * ceiling), and they are not a substitute for these. The limiter bounds one IP
 * and does nothing about a thousand; the ceiling bounds rows and does nothing
 * about request volume. These bound the CLIENT, which is where all four of the
 * failures above actually originate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reportClientError, MAX_REPORTS_PER_LOAD, __resetReporter } from './errorReporting';
import { ApiError } from './api';

let sent;

beforeEach(() => {
  __resetReporter();
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('what gets reported', () => {
  it('sends a crash to the intake endpoint', async () => {
    reportClientError(new Error('event.slots is not iterable'), { kind: 'crash', route: '/events' });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/errors/report');
    expect(sent[0].body.message).toContain('event.slots is not iterable');
    expect(sent[0].body.kind).toBe('crash');
    expect(sent[0].body.route).toBe('/events');
  });

  /**
   * `source`, `release`, `status`, `fingerprint` and `user_hash` are assigned
   * server-side and ignored if sent. A client that supplies `source: 'server'`
   * would otherwise escape the client-group ceiling entirely — so this asserts
   * we do not even try, rather than relying on the server to refuse us.
   */
  it('claims nothing the server decides for itself', async () => {
    reportClientError(new Error('boom'), { kind: 'crash', route: '/' });
    await flush();

    for (const field of ['source', 'release', 'status', 'fingerprint', 'user_hash', 'userHash']) {
      expect(sent[0].body, `client supplied ${field}`).not.toHaveProperty(field);
    }
  });

  it('reports a 5xx, which is a real defect on our side', async () => {
    reportClientError(new ApiError('Internal Server Error', { status: 500 }), { route: '/events' });
    await flush();
    expect(sent).toHaveLength(1);
  });
});

describe('what must never be reported', () => {
  /**
   * Someone on a bus with one bar is not a bug. The offline experience already
   * tells them what happened; sending it to the error table would drown the
   * real signal in the one failure we can do nothing about.
   */
  it('says nothing about a network error', async () => {
    reportClientError(new ApiError('Network request failed', { isNetworkError: true }), { route: '/' });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('still reports a 4xx/5xx ApiError, which is not a network error', async () => {
    reportClientError(new ApiError('Server exploded', { status: 503 }), { route: '/' });
    await flush();
    expect(sent).toHaveLength(1);
  });

  /**
   * The loop that matters most. A failing reporter must not report its own
   * failure — at network speed, from every open tab, forever.
   */
  it('does not report a failure that happened while reporting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      // The transport itself fails, the way it would if the server were down.
      reportClientError(new Error('reporting failed'), { route: '/' });
      throw new Error('network down');
    }));

    reportClientError(new Error('the original problem'), { route: '/' });
    await flush();
    expect(globalThis.fetch, 're-entered the reporter').toHaveBeenCalledTimes(1);
  });

  it('survives a transport that rejects, rather than throwing into the boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    // A throw here would turn a CAUGHT render error into an uncaught one.
    expect(() => reportClientError(new Error('x'), { route: '/' })).not.toThrow();
    await flush();
  });

  /**
   * The loop that actually closes, and the one a mutation test caught me
   * missing.
   *
   * The re-entrancy flag is released synchronously, before `fetch` settles. So
   * if the request's rejection is left unhandled, it surfaces as an
   * `unhandledrejection` event — and `main.jsx` listens for those and reports
   * them. Reporter fails → global handler → reporter → fails. The flag is no
   * defence at all across that gap, because by then it is already false.
   *
   * Asserted against the real signal rather than by inspecting the code: no
   * unhandled rejection may escape this module, whatever the transport does.
   */
  it('handles its own transport failure, so it cannot feed the global handler', async () => {
    /* Asserted by watching whether a rejection handler is ATTACHED, not by
       waiting for an unhandled-rejection event: vitest installs its own
       `unhandledRejection` listener, so Node never reports one and a test built
       on that signal passes whether or not the handler exists. It did, which is
       how this test came to be written twice. */
    let handlerAttached = false;
    const rejected = Promise.reject(new Error('network down'));
    rejected.catch(() => {});  // keep the probe itself from being the unhandled one

    vi.stubGlobal('fetch', vi.fn(() => ({
      catch(onRejected) { handlerAttached = true; return rejected.catch(onRejected); },
      then(...args) { return rejected.then(...args); },
    })));

    reportClientError(new Error('the original problem'), { route: '/' });
    await flush();

    expect(
      handlerAttached,
      'the report’s rejection is unhandled — it will reach the unhandledrejection '
      + 'listener in main.jsx, which reports it, which fails, which reports it'
    ).toBe(true);
  });

  it('survives a hostile error object', async () => {
    const hostile = { get message() { throw new Error('boom'); }, get stack() { throw new Error('boom'); } };
    expect(() => reportClientError(hostile, { route: '/' })).not.toThrow();
    await flush();
  });

  it('ignores nothing at all', async () => {
    for (const nothing of [null, undefined]) {
      reportClientError(nothing, { route: '/' });
    }
    await flush();
    expect(sent).toHaveLength(0);
  });
});

describe('the caps that stop one bug becoming thousands of rows', () => {
  /**
   * React re-renders a throwing tree many times per second. Without a dedupe
   * key, one broken component is an unbounded stream of identical reports.
   */
  it('reports one repeating crash once, however many times it fires', async () => {
    const boom = () => { const e = new Error('same failure'); e.stack = 'Error: same failure\n    at Foo (/src/Foo.jsx:1:1)'; return e; };
    for (let i = 0; i < 50; i++) reportClientError(boom(), { route: '/events' });
    await flush();
    expect(sent).toHaveLength(1);
  });

  /**
   * Deduping is by message AND first frame: the same message thrown from two
   * different components is two defects, not one.
   */
  it('treats the same message from a different frame as a different problem', async () => {
    const at = (frame) => { const e = new Error('same message'); e.stack = `Error: same message\n    at ${frame}`; return e; };
    reportClientError(at('Foo (/src/Foo.jsx:1:1)'), { route: '/' });
    reportClientError(at('Bar (/src/Bar.jsx:9:9)'), { route: '/' });
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('stops at the per-load cap even with all-distinct failures', async () => {
    for (let i = 0; i < MAX_REPORTS_PER_LOAD + 20; i++) {
      reportClientError(new Error(`distinct failure ${i}`), { route: '/' });
    }
    await flush();
    expect(sent).toHaveLength(MAX_REPORTS_PER_LOAD);
  });

  it('drops silently past the cap — the server already has the fingerprint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_REPORTS_PER_LOAD + 5; i++) {
      reportClientError(new Error(`f${i}`), { route: '/' });
    }
    await flush();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caps low enough to be a cap at all', () => {
    // A "cap" of 1000 is not one. Pinned so it cannot drift upward quietly.
    expect(MAX_REPORTS_PER_LOAD).toBeLessThanOrEqual(10);
    expect(MAX_REPORTS_PER_LOAD).toBeGreaterThan(0);
  });
});

/**
 * The correlation id, and why the reporter is allowed to echo one back.
 *
 * Every other field the server needs — `source`, `release`, `status`,
 * `fingerprint`, `user_hash` — is assigned server-side and ignored when a client
 * sends it, because a report claiming `source: 'server'` would escape the
 * client-group ceiling. `requestId` is the single exception, and it is safe for
 * the opposite reason: the SERVER minted it and handed it back on
 * `X-Request-Id`, so a client echoing it can at worst point at a request that
 * already exists.
 *
 * It is what joins a browser crash to the API call that caused it, to the access
 * record for that call, and to the error row — see docs/operations/betterstack.md §5.
 */
describe('the request id that threads a crash to its API call', () => {
  const sentBody = () => JSON.parse(globalThis.fetch.mock.calls[0][1].body);

  const apiFailure = (requestId) => Object.assign(new Error('Server error'), {
    name: 'ApiError', requestId,
  });

  it('sends the id when the error came from a failed API call', () => {
    reportClientError(apiFailure('b3f1c2d4-0000-4a1b-9c3d-1122334455aa'), { kind: 'crash' });
    expect(sentBody().requestId).toBe('b3f1c2d4-0000-4a1b-9c3d-1122334455aa');
  });

  it('omits it for a crash with no failed request behind it', () => {
    reportClientError(new Error('Cannot read properties of null'), { kind: 'crash' });
    expect(sentBody().requestId).toBeUndefined();
  });

  /**
   * Shape-checked before it is sent. This runs on an error path; a value that is
   * not a plain id is not worth a second failure, and the server re-checks it
   * anyway because the intake is unauthenticated.
   */
  it('refuses anything that is not identifier-shaped', () => {
    for (const bad of ['leo.chen@example.com', 'id with spaces', '<script>', 'x'.repeat(200), 42, {}]) {
      __resetReporter();
      globalThis.fetch.mockClear();
      reportClientError(apiFailure(bad), { kind: 'crash' });
      expect(sentBody().requestId, String(bad)).toBeUndefined();
    }
  });

  it('never reads anything else off the error object', () => {
    const err = apiFailure('b3f1c2d4-0000-4a1b-9c3d-1122334455aa');
    err.data = { email: 'leo.chen@example.com', password: 'hunter2' };
    err.status = 500;
    reportClientError(err, { kind: 'crash' });
    const body = sentBody();
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('status');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
