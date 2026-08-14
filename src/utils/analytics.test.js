import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Amplitude seam.
 *
 * ── What these cases are actually protecting ──
 *
 * Not "does Amplitude work" — that is answered by an event appearing in
 * Amplitude's live feed, and no test here can or should claim it. These protect
 * the two properties that matter to WeVolunteer whether or not Amplitude is
 * reachable:
 *
 *   1. The application does not depend on it. A missing key, a throwing SDK, a
 *      blocked request — none of them may reach the caller as an exception. The
 *      caller is a render path.
 *   2. It initialises once and sends one event. `<StrictMode>` mounts twice in
 *      development, so "once" has to be a property of the module rather than of
 *      who calls it.
 *
 * The SDK is mocked throughout. A test that reached api2.amplitude.com would be
 * slow, flaky, offline-hostile, and would post junk into a real project.
 */

const track = vi.fn();
const initAll = vi.fn();

vi.mock('@amplitude/unified', () => ({
  initAll: (...args) => initAll(...args),
  track: (...args) => track(...args),
}));

/** Loads the module fresh with a chosen key, so module-scope state is clean. */
async function loadWithKey(key) {
  vi.resetModules();
  vi.stubEnv('VITE_AMPLITUDE_API_KEY', key);
  return import('./analytics.js');
}

beforeEach(() => {
  track.mockClear();
  initAll.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('when the key is configured', () => {
  it('initialises with initAll, autocapture on and full replay sampling', async () => {
    const a = await loadWithKey('test-key-not-the-real-one');
    expect(a.initializeAmplitude()).toBe(true);

    expect(initAll).toHaveBeenCalledTimes(1);
    const [key, options] = initAll.mock.calls[0];
    expect(key).toBe('test-key-not-the-real-one');
    /* Exactly the wizard's shape. `init` is not used and is not even exported
       by this package — it is analytics-only and would silently leave Session
       Replay off. */
    expect(options).toEqual({
      analytics: { autocapture: true },
      sessionReplay: { sampleRate: 1 },
    });
  });

  it('initialises only once, however many times it is called', async () => {
    /* `<StrictMode>` mounts everything twice in development. */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    a.initializeAmplitude();
    a.initializeAmplitude();
    expect(initAll).toHaveBeenCalledTimes(1);
  });

  it('sends an event with the properties it was given', async () => {
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    a.trackAmplitudeEvent('Viewed Home Page', { prompt_version: 'BA400.4' });

    expect(track).toHaveBeenCalledTimes(1);
    const [name, props] = track.mock.calls[0];
    expect(name).toBe('Viewed Home Page');
    expect(props.prompt_version).toBe('BA400.4');
  });

  it('marks which build the event came from', async () => {
    /* A plain event property, not an SDK option — inventing a configuration
       key that does not exist is how an install silently stops reporting. */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    a.trackAmplitudeEvent('Viewed Home Page', { prompt_version: 'BA400.4' });
    expect(track.mock.calls[0][1].environment).toBeTruthy();
  });

  it('sends nothing that identifies a person', async () => {
    /**
     * The property this whole seam exists for. The event carries a version
     * marker and a build name — no id, no name, no address, no school, no year
     * group, no token, and nothing a user typed.
     */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    a.trackAmplitudeEvent('Viewed Home Page', { prompt_version: 'BA400.4' });

    const props = track.mock.calls[0][1];
    expect(Object.keys(props).sort()).toEqual(['environment', 'prompt_version']);
    const serialised = JSON.stringify(props).toLowerCase();
    for (const forbidden of ['email', 'token', 'password', 'name', 'school', 'grade', 'userid', '@']) {
      expect(serialised, `event carried "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('when the key is absent', () => {
  it('warns once and reports analytics as off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await loadWithKey('');

    expect(a.isAnalyticsConfigured()).toBe(false);
    expect(a.initializeAmplitude()).toBe(false);
    expect(warn).toHaveBeenCalledWith('Amplitude API key missing — analytics disabled');
  });

  it('does not touch the SDK at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await loadWithKey('');
    a.initializeAmplitude();
    expect(initAll).not.toHaveBeenCalled();
  });

  it('makes tracking a silent no-op rather than an error', async () => {
    /* The application must run normally with analytics switched off — which is
       the DEFAULT, since .env.example ships the variable empty. */
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await loadWithKey('');
    a.initializeAmplitude();

    expect(() => a.trackAmplitudeEvent('Viewed Home Page', { prompt_version: 'BA400.4' })).not.toThrow();
    expect(track).not.toHaveBeenCalled();
  });
});

describe('when the SDK itself misbehaves', () => {
  it('does not let a failing init reach the caller', async () => {
    /**
     * The realistic case, not a hypothetical: a Content Security Policy that
     * refuses the request, an ad blocker, a network that drops it. WeVolunteer
     * has to render regardless — an analytics SDK that can break the page it
     * measures is worse than no analytics.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    /* Persistently, not `mockImplementationOnce`: a single-shot throw would let
       the second call succeed and the assertion would pass for the wrong
       reason. A CSP does not relent on the second attempt either. */
    initAll.mockImplementation(() => { throw new Error('blocked by CSP'); });

    const a = await loadWithKey('test-key-not-the-real-one');
    expect(() => a.initializeAmplitude()).not.toThrow();
    expect(a.initializeAmplitude()).toBe(false);
    initAll.mockReset();
  });

  it('does not send an event after a failed init', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    initAll.mockImplementation(() => { throw new Error('blocked by CSP'); });

    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    initAll.mockReset();
    a.trackAmplitudeEvent('Viewed Home Page', { prompt_version: 'BA400.4' });
    expect(track).not.toHaveBeenCalled();
  });

  it('does not let a failing track reach the caller', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    track.mockImplementationOnce(() => { throw new Error('transport gone'); });

    expect(() => a.trackAmplitudeEvent('Viewed Home Page')).not.toThrow();
  });
});

describe('the verification event is declared exactly once', () => {
  it('appears in one place in the source, with the wizard property', async () => {
    /**
     * A source scan, because "exactly one event" is a property of the codebase
     * rather than of a render. A second `trackAmplitudeEvent` added later would
     * pass every behavioural case above and still be the taxonomy the brief
     * forbids.
     */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = path.join(process.cwd(), 'src');

    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full);
      }
    };
    walk(src);

    const callSites = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      /* The definition and the re-export in analytics.js itself are not calls. */
      if (f.endsWith(`${path.sep}analytics.js`)) continue;
      for (const m of text.matchAll(/trackAmplitudeEvent\(\s*'([^']+)'/g)) {
        callSites.push({ file: path.relative(src, f), event: m[1] });
      }
    }

    expect(callSites, `expected one explicit event, found: ${JSON.stringify(callSites)}`).toHaveLength(1);
    expect(callSites[0].event).toBe('Viewed Home Page');

    const mainSrc = fs.readFileSync(path.join(src, 'main.jsx'), 'utf8');
    expect(mainSrc).toContain("prompt_version: 'BA400.4'");
  });

  it('is not imported anywhere on the server', async () => {
    /* Amplitude is client-only. The Express process must never load it. */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const serverDir = path.join(process.cwd(), 'server');

    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
        if (!/\.js$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/@amplitude|utils\/analytics/.test(text)) offenders.push(path.relative(serverDir, full));
      }
    };
    walk(serverDir);

    expect(offenders, `server code referencing Amplitude: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('the production Content Security Policy allows Amplitude', () => {
  /**
   * Without this the SDK fails SILENTLY in production: the page renders, no
   * visible error appears, and every event is refused by the browser. An
   * integration that looks installed and measures nothing is the worst outcome,
   * and it is invisible from the code alone — which is why the policy is pinned
   * here rather than left to be discovered after launch.
   *
   * Read from source: helmet's config is applied at import time and asserting it
   * through a live response would need a booted server for a string comparison.
   */
  const csp = () => {
    const fs = require('node:fs');
    const path = require('node:path');
    return fs.readFileSync(path.join(process.cwd(), 'server', 'app.js'), 'utf8');
  };

  it('lets the page reach the ingestion and config hosts', () => {
    const src = csp();
    for (const host of [
      'https://api2.amplitude.com',
      'https://sr-client-cfg.amplitude.com',
      'https://gs.amplitude.com',
      'https://cdn.amplitude.com',
    ]) {
      expect(src, `connectSrc is missing ${host}`).toContain(host);
    }
  });

  it('lets Session Replay start its blob worker', () => {
    /* workerSrc falls back to scriptSrc then defaultSrc, neither of which
       allows blob: — so the recorder is refused without this. */
    expect(csp()).toMatch(/workerSrc: \[[^\]]*'blob:'/);
  });

  it('still refuses inline script', () => {
    /* The directive that actually stops an injected <script>. Widening the
       policy for analytics must not have relaxed this. */
    expect(csp()).not.toMatch(/scriptSrc: \[[^\]]*unsafe-inline/);
  });
});
