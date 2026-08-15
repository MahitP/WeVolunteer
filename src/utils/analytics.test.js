import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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
const setOptOut = vi.fn();

vi.mock('@amplitude/unified', () => ({
  initAll: (...args) => initAll(...args),
  track: (...args) => track(...args),
  setOptOut: (...args) => setOptOut(...args),
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
  setOptOut.mockReset();
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
    /* `init` is not used and is not even exported by this package — it is
       analytics-only and would silently leave Session Replay off. */
    expect(options.analytics).toEqual({ autocapture: true });
    expect(options.sessionReplay.sampleRate).toBe(1);
  });

  it('records no page text at all, at any mask level below conservative', async () => {
    /**
     * THE regression, and it is worth stating why in the assertion rather than
     * the name.
     *
     * Amplitude's own default is `medium`, which its source documents as
     * "All inputs (form fields), text is NOT masked". Every sensitive thing
     * this application shows is RENDERED rather than typed — hours,
     * transcripts, messages, moderation notes, ban reasons, and the two-factor
     * secret and recovery codes. Under `medium` all of it is uploaded verbatim.
     */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    const { privacyConfig } = initAll.mock.calls[0][1].sessionReplay;

    expect(
      privacyConfig?.defaultMaskLevel,
      'the replay mask level is no longer conservative — rendered page text, '
      + 'including service records and moderation notes, is being recorded'
    ).toBe('conservative');
  });

  it('blocks the annotated subtrees outright, not merely masking them', async () => {
    /* Masking replaces visible characters. It does nothing to an <img src>,
       and the 2FA QR is a data URL containing the shared secret. */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    const { privacyConfig } = initAll.mock.calls[0][1].sessionReplay;

    expect(privacyConfig?.blockSelector).toContain(`[${a.REPLAY_BLOCK_ATTRIBUTE}]`);
  });

  it('enables interaction tracking, which is what applies the URL rules', async () => {
    /**
     * Not a decision to collect more. The SDK gates `ugcFilterRules` on
     * `interactionConfig.enabled`, and with it off the INITIAL snapshot's href
     * is stored raw — which is the one that carries the token, because it is
     * the link out of the email.
     */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.initializeAmplitude();
    const { interactionConfig } = initAll.mock.calls[0][1].sessionReplay;

    expect(interactionConfig?.enabled).toBe(true);
    expect(interactionConfig?.ugcFilterRules).toEqual([...a.REDACTED_URL_RULES]);
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

    /**
     * The call site moved out of `main.jsx` when analytics became conditional
     * on consent: at module scope there is no account, so there is no answer to
     * read. It lives in the hook that owns the decision instead.
     */
    expect(callSites[0].file).toBe(path.join('hooks', 'useAnalyticsConsent.js'));
    const hookSrc = fs.readFileSync(path.join(src, 'hooks', 'useAnalyticsConsent.js'), 'utf8');
    expect(hookSrc).toContain("prompt_version: 'BA400.4'");
  });

  it('is not started from module scope any more', () => {
    /**
     * The regression that would silently un-do consent.
     *
     * `main.jsx` runs before React mounts and therefore before any session
     * exists. A call to `initializeAmplitude` there starts recording for
     * everybody, including people who declined — and it would look perfectly
     * reasonable in a diff, because that is where it used to live.
     */
    const mainSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'main.jsx'), 'utf8');
    expect(
      /^\s*(const\s+\w+\s*=\s*)?initializeAmplitude\(\)/m.test(mainSrc),
      'main.jsx starts Amplitude at module scope again — that runs before the '
      + 'session loads, so it cannot know whether this person consented'
    ).toBe(false);
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

describe('nothing is recorded without consent', () => {
  /**
   * The property the whole consent mechanism exists for, asserted at the seam
   * rather than through the UI.
   *
   * `analyticsConsent` has three states and only one of them is a yes.
   * `null` — the value every existing account has after migration 052, because
   * none of them was ever asked — must behave exactly like an explicit no.
   */
  it.each([
    ['null, meaning never asked', null],
    ['an explicit decline', false],
    ['undefined, for a signed-out visitor', undefined],
    ['the STRING "true", which is truthy and is not consent', 'true'],
    ['the number 1', 1],
  ])('does not start Amplitude for %s', async (_label, value) => {
    const a = await loadWithKey('test-key-not-the-real-one');
    expect(a.applyAnalyticsConsent(value)).toBe(false);
    expect(initAll, 'Amplitude was initialised without consent').not.toHaveBeenCalled();
  });

  it('starts it for an explicit yes', async () => {
    const a = await loadWithKey('test-key-not-the-real-one');
    expect(a.applyAnalyticsConsent(true)).toBe(true);
    expect(initAll).toHaveBeenCalledTimes(1);
  });

  it('stops recording immediately when consent is withdrawn', async () => {
    /**
     * Not "stops at the next reload". Session Replay records continuously, so
     * the gap between turning the switch off and the page reloading is a period
     * of recording the person has explicitly withdrawn consent for. Amplitude
     * cannot be un-initialised, and `setOptOut` is its own answer to this.
     */
    const a = await loadWithKey('test-key-not-the-real-one');
    a.applyAnalyticsConsent(true);
    expect(setOptOut).not.toHaveBeenCalled();

    expect(a.applyAnalyticsConsent(false)).toBe(false);
    expect(setOptOut).toHaveBeenCalledWith(true);
  });

  it('resumes when consent is given back in the same tab', async () => {
    const a = await loadWithKey('test-key-not-the-real-one');
    a.applyAnalyticsConsent(true);
    a.applyAnalyticsConsent(false);
    setOptOut.mockClear();

    expect(a.applyAnalyticsConsent(true)).toBe(true);
    expect(setOptOut).toHaveBeenCalledWith(false);
    /* Not initialised a second time — the SDK is already running. */
    expect(initAll).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the SDK refuses to switch off', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await loadWithKey('test-key-not-the-real-one');
    a.applyAnalyticsConsent(true);
    setOptOut.mockImplementationOnce(() => { throw new Error('gone'); });

    expect(() => a.applyAnalyticsConsent(false)).not.toThrow();
  });
});

describe('credentials in the address bar never reach the recorder', () => {
  /**
   * These cases run the rules through **Amplitude's own glob compiler**, not a
   * reimplementation of it.
   *
   * That distinction is the whole value of this block. Asserting that
   * `REDACTED_URL_RULES` contains the strings I typed proves only that I typed
   * them; the property that matters is whether the SDK, given those strings and
   * a real URL, produces a redacted one. The glob dialect is not obvious —
   * `?` compiles to a single-character wildcard, `*` to `.*`, the pattern is
   * anchored at both ends, and it is matched against the FULL href rather than
   * the path — so a rule that looks right and matches nothing is the likely
   * failure, and it would be a silent one.
   *
   * `createRequire` because the package's ESM build uses extensionless internal
   * imports that only a bundler resolves; the CJS build loads under Node as-is.
   */
  const require = createRequire(import.meta.url);
  const { getPageUrl, validateUGCFilterRules } =
    require('@amplitude/session-replay-browser/lib/cjs/helpers.js');

  /** Loads the module without touching the once-only init state. */
  async function rules() {
    const a = await import('./analytics.js');
    return [...a.REDACTED_URL_RULES];
  }

  it('are accepted by the SDK, so a typo cannot silently disable analytics', async () => {
    /**
     * `validateUGCFilterRules` THROWS on a malformed rule, and the throw would
     * happen inside `initAll` — which `initializeAmplitude` catches and turns
     * into "analytics disabled". So a bad pattern here does not fail loudly, it
     * quietly switches the whole integration off. This is the case that notices.
     */
    const rs = await rules();
    expect(() => validateUGCFilterRules(rs)).not.toThrow();
  });

  it.each([
    ['a password reset link', 'https://wevolunteers.org/?reset=Q7fNc2Lm9xKpR4'],
    ['an email verification link', 'https://wevolunteers.org/?verify=Zk3Wq8Tb1vHy6N'],
    ['the reset form it forwards to', 'https://wevolunteers.org/reset-password?token=Q7fNc2Lm9xKpR4'],
    ['an invitation link', 'https://wevolunteers.org/accept-invitation?token=Bd5Jr0Pw7sXt2M'],
    ['an appeal link, whose token is a path segment', 'https://wevolunteers.org/appeal/Vn8Hq3Lz6cRw1K'],
    ['the same link over plain http', 'http://localhost:5184/?reset=Q7fNc2Lm9xKpR4'],
  ])('redact %s', async (_label, href) => {
    const recorded = getPageUrl(href, await rules());

    /* The token itself is the thing that must be gone. Asserted by searching
       for the secret rather than by comparing to an expected string, so the
       case still fails if the replacement text changes but the token survives
       somewhere else in the URL. */
    const secret = href.split(/[=/]/).pop();
    expect(recorded, `the token survived in ${recorded}`).not.toContain(secret);
    expect(recorded).toContain('[redacted]');
  });

  it('leave ordinary URLs alone', async () => {
    /**
     * The control case, and it is not decoration: a rule broad enough to redact
     * everything would pass every assertion above while destroying the dataset
     * the recorder exists to produce. Both halves have to hold.
     */
    const untouched = [
      'https://wevolunteers.org/dashboard',
      'https://wevolunteers.org/discover',
      'https://wevolunteers.org/organizations/river-club',
      'https://wevolunteers.org/events?category=Environment',
    ];
    const rs = await rules();
    for (const href of untouched) {
      expect(getPageUrl(href, rs), `${href} was redacted and should not have been`).toBe(href);
    }
  });
});

describe('the screens that render a credential are blocked in the markup', () => {
  /**
   * A source check, because the property is "somebody remembered to annotate
   * this element". Rendering the component and inspecting the DOM would prove
   * the attribute reaches the browser, which is not in doubt — what is in doubt
   * is whether a future edit moves the secret out from under it.
   */
  const tfa = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'account', 'TwoFactorSetup.jsx'), 'utf8'
  );

  it('blocks the QR image, whose data URL contains the shared secret', () => {
    expect(tfa).toMatch(/<div data-replay-block[^>]*>\s*\n\s*<img\s*\n\s*src=\{enrol\.qr\}/);
  });

  it('blocks the typed-out secret shown for people who cannot scan', () => {
    expect(tfa).toMatch(/<code data-replay-block[^>]*>\{enrol\.secret\}<\/code>/);
  });

  it('blocks the recovery codes', () => {
    expect(tfa).toMatch(/<ul\s*\n\s*data-replay-block/);
  });

  it('leaves the six-digit code field alone', () => {
    /* Scoping matters in both directions. The input the user types their code
       into is ephemeral and is masked anyway; blocking it would remove the one
       part of the screen that is useful for diagnosing a failed enrolment. */
    const inputBlock = tfa.slice(tfa.indexOf('id="tfa-enrol-code"') - 300, tfa.indexOf('id="tfa-enrol-code"') + 200);
    expect(inputBlock).not.toContain('data-replay-block');
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
