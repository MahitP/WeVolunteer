import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STEP_UP, REAUTH_CHALLENGE_HEADER, reauthHeader, needsStepUp, actionFromError,
  withStepUp, savePendingReauth, takePendingReauth, saveReadyGrant, takeReadyGrant
} from './stepUp';
import { SENSITIVE_ACTIONS } from '../../server/sensitiveActions.js';
import { api } from './api';

/**
 * The client's half of step-up, tested at the seam where it goes wrong.
 *
 * None of this is a security boundary — the server re-checks every binding when
 * the grant is spent. What these tests protect is the property that makes the
 * feature usable at all: the client must ask for the SAME action with the SAME
 * arguments that the request will carry, and must actually spend what it earned.
 * Get either wrong and the user verifies successfully, the action is refused, and
 * the UI sends them back to the dialog they just completed — for ever, with no
 * error message anywhere that says why.
 */

beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

/**
 * A build-failing guard over the client, added after the same bug landed twice.
 *
 * ── The bug ──
 *
 * Task 6 changed five `api` methods so that their last argument is the headers
 * object carrying the step-up grant. Two call sites were still passing the old
 * `password` argument in that position: `src/views/Login.jsx` (the provider-link
 * screen) and `src/components/account/VerifyEmailWall.jsx` (the only way out for
 * an account with a mistyped address). A string spread into `headers` produces
 * `{0:'p',1:'a',…}`, no grant is presented, and the endpoint answers 403 — which
 * both screens reported as "Incorrect password." and "Could not change that
 * address."
 *
 * Neither was caught, because neither screen had a test that submitted its form.
 * Fixing the two instances does not stop a third, so the class is checked here:
 * a gated endpoint must be called with something named `headers`, which in
 * practice means from inside a `run(...)` or `verifyFirst(...)` callback.
 *
 * Deliberately a source scan rather than a runtime check. The failure is a
 * *missing* call — nothing throws, nothing logs, and the endpoint's own tests
 * pass — so it has to be caught at build time or not at all. The same reasoning
 * as Guards 4 and 5 in `server/authz.completeness.test.js`.
 */
describe('every gated endpoint is called with its grant', () => {
  /** The `api` methods whose last argument became the headers object in Task 6. */
  const GATED_METHODS = [
    'changePassword', 'changeEmail', 'deleteAccount', 'requestExport', 'linkOAuthAccount'
  ];

  /**
   * Call sites of `api.<method>(…)` in one source file.
   *
   * Kept as a function over a string so the self-test below can drive it with the
   * exact bug. Reading a regex and believing it is how three role checks got past
   * a guard earlier in this project.
   */
  function findGatedCalls(src) {
    const found = [];
    src.split('\n').forEach((line, i) => {
      // A line that only mentions the name in prose is not a call site.
      if (/^\s*(\*|\/\/)/.test(line)) return;
      for (const method of GATED_METHODS) {
        const re = new RegExp(`\\bapi\\.${method}\\s*\\(([^)]*)\\)`, 'g');
        for (const m of line.matchAll(re)) {
          found.push({ line: i + 1, method, args: m[1].trim() });
        }
      }
    });
    return found;
  }

  /** Whether a call site hands the grant along. */
  const carriesGrant = (args) => /\bheaders\b/.test(args);

  it('fires on a call that passes a password, and not on a correct one', () => {
    // The exact shape of both real bugs.
    const bug = findGatedCalls('      const res = await api.changeEmail(newEmail.trim(), password);');
    expect(bug).toHaveLength(1);
    expect(bug[0].method).toBe('changeEmail');
    expect(carriesGrant(bug[0].args)).toBe(false);

    const alsoBug = findGatedCalls('      await api.linkOAuthAccount(linkData.linkToken, password);');
    expect(carriesGrant(alsoBug[0].args)).toBe(false);

    // The shapes that are correct.
    expect(carriesGrant(findGatedCalls('        headers => api.changeEmail(target, headers)')[0].args)).toBe(true);
    expect(carriesGrant(findGatedCalls('        headers => api.deleteAccount(headers)')[0].args)).toBe(true);
    expect(carriesGrant(findGatedCalls('  requestExport: async (headers = {}) => apiFetch(')[0]?.args ?? 'headers')).toBe(true);

    // Prose mentioning a method is not a call site.
    expect(findGatedCalls("   * `api.changeEmail(newEmail, password)` used to take a password.")).toEqual([]);
    expect(findGatedCalls("// api.deleteAccount(password) was the old shape")).toEqual([]);
  });

  it('finds no gated call missing its grant anywhere in src/', async () => {
    const { readFileSync, readdirSync } = await import('fs');
    const path = await import('path');
    const SRC = path.join(process.cwd(), 'src');

    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx?$/.test(entry.name) || /\.test\.jsx?$/.test(entry.name)) continue;
        files.push(full);
      }
    };
    walk(SRC);
    expect(files.length, 'the src/ walk found nothing to scan').toBeGreaterThan(0);

    const offenders = [];
    for (const file of files) {
      const rel = path.relative(process.cwd(), file);
      // api.js is where the methods are DEFINED; its own `headers = {}`
      // parameters are the definition, not a call.
      if (rel === path.join('src', 'utils', 'api.js')) continue;

      for (const site of findGatedCalls(readFileSync(file, 'utf8'))) {
        if (!carriesGrant(site.args)) {
          offenders.push(
            `${rel}:${site.line}: api.${site.method}(${site.args}) does not pass the step-up `
            + 'headers. This endpoint is behind requireAAL2, so without the grant it answers 403 '
            + 'and the screen reports a credential error it cannot recover from. Call it through '
            + "useStepUp's run(...) or verifyFirst(...) so the retry carries the header."
          );
        }
      }
    }

    expect(offenders, 'gated endpoint call(s) with no step-up grant').toEqual([]);
  });
});

describe('the action names come from the shared registry', () => {
  /**
   * A name that has drifted out of the registry cannot produce a grant, so the
   * endpoint would refuse every caller. `stepUp.js` throws at module load rather
   * than at 403 time, and this asserts the pairing that makes that check real.
   */
  it('every STEP_UP value is a registered sensitive action', () => {
    for (const [key, action] of Object.entries(STEP_UP)) {
      expect(
        Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, action),
        `STEP_UP.${key} is '${action}', which the registry does not know`
      ).toBe(true);
    }
  });

  it('covers every action the registry declares — a gated endpoint with no client entry is unusable', () => {
    expect(Object.values(STEP_UP).sort()).toEqual(Object.keys(SENSITIVE_ACTIONS).sort());
  });
});

describe('recognising a request for verification', () => {
  const refusal = (over = {}) => Object.assign(new Error('Identity verification required'), {
    status: 403,
    data: { error: 'Identity verification required', code: 'reauth_required', action: 'data.export', ...over }
  });

  it('matches on the code, not merely the status', () => {
    expect(needsStepUp(refusal())).toBe(true);
    expect(actionFromError(refusal())).toBe('data.export');
  });

  /**
   * A capability gate also answers 403, and it means "you may never do this".
   * Offering to verify would be a prompt that cannot succeed no matter what the
   * user types.
   */
  it('does not mistake a capability denial for a verification prompt', () => {
    const denied = Object.assign(new Error('Forbidden'), {
      status: 403, data: { error: 'Forbidden' }
    });
    expect(needsStepUp(denied)).toBe(false);
    expect(actionFromError(denied)).toBeNull();
  });

  it('ignores other statuses and non-errors', () => {
    expect(needsStepUp(Object.assign(new Error('x'), { status: 401, data: { code: 'reauth_required' } }))).toBe(false);
    expect(needsStepUp(undefined)).toBe(false);
    expect(needsStepUp(null)).toBe(false);
  });
});

describe('reauthHeader', () => {
  it('uses the one wire name', () => {
    expect(reauthHeader('reauth-1')).toEqual({ [REAUTH_CHALLENGE_HEADER]: 'reauth-1' });
    expect(REAUTH_CHALLENGE_HEADER).toBe('X-Reauth-Challenge');
  });

  /**
   * An absent id must produce no header rather than `{'X-Reauth-Challenge':
   * undefined}`, which serialises to the literal string "undefined" and would be
   * looked up as a challenge id — turning a missing grant into a 404 about a
   * challenge that never existed.
   */
  it('produces nothing at all for a missing id', () => {
    expect(reauthHeader(undefined)).toEqual({});
    expect(reauthHeader(null)).toEqual({});
    expect(reauthHeader('')).toEqual({});
  });
});

describe('withStepUp', () => {
  it('does not verify anything when the request simply succeeds', async () => {
    const open = vi.spyOn(api, 'openReauthChallenge');
    const verify = vi.fn();

    const result = await withStepUp(STEP_UP.DATA_EXPORT, {}, async () => ({ jobId: 'j1' }), verify);

    expect(result).toEqual({ jobId: 'j1' });
    expect(open).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('opens a challenge for the declared action and retries with the header', async () => {
    vi.spyOn(api, 'openReauthChallenge').mockResolvedValue({
      challengeId: 'reauth-9', action: 'email.change', methods: ['password'],
      expiresAt: new Date(Date.now() + 300000).toISOString()
    });

    const seen = [];
    const attempt = vi.fn(async (headers) => {
      seen.push(headers);
      if (!headers[REAUTH_CHALLENGE_HEADER]) {
        throw Object.assign(new Error('Identity verification required'), {
          status: 403, data: { code: 'reauth_required', action: 'email.change' }
        });
      }
      return { pending: 'new@example.org' };
    });

    const result = await withStepUp(
      STEP_UP.EMAIL_CHANGE,
      { newEmail: 'new@example.org' },
      attempt,
      async () => 'reauth-9'
    );

    expect(result).toEqual({ pending: 'new@example.org' });
    expect(api.openReauthChallenge).toHaveBeenCalledWith('email.change', { newEmail: 'new@example.org' });
    expect(seen[0]).toEqual({});
    expect(seen[1]).toEqual({ [REAUTH_CHALLENGE_HEADER]: 'reauth-9' });
  });

  /**
   * Dismissal is an outcome, not a failure. Returning undefined rather than
   * throwing is what lets a caller skip its success toast without also showing an
   * error blaming the user for a choice they were offered.
   */
  it('returns undefined and does not retry when the user dismisses the dialog', async () => {
    vi.spyOn(api, 'openReauthChallenge').mockResolvedValue({
      challengeId: 'reauth-x', action: 'account.delete', methods: ['password'],
      expiresAt: new Date(Date.now() + 300000).toISOString()
    });
    const attempt = vi.fn(async () => {
      throw Object.assign(new Error('nope'), {
        status: 403, data: { code: 'reauth_required', action: 'account.delete' }
      });
    });

    const result = await withStepUp(STEP_UP.ACCOUNT_DELETE, {}, attempt, async () => null);

    expect(result).toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('passes a non-step-up failure straight through', async () => {
    const conflict = Object.assign(new Error('An export is already in progress.'), {
      status: 409, data: { error: 'An export is already in progress.' }
    });
    const verify = vi.fn();

    await expect(
      withStepUp(STEP_UP.DATA_EXPORT, {}, async () => { throw conflict; }, verify)
    ).rejects.toBe(conflict);

    // The point of trying first: the user is told what is actually wrong instead
    // of being asked to prove who they are for something that cannot proceed.
    expect(verify).not.toHaveBeenCalled();
  });

  /**
   * A caller that declares one action while the endpoint asks for another would
   * open a grant the endpoint refuses. Silently proceeding produces exactly the
   * "verification does not work" loop this whole layer exists to avoid, so it is
   * a programming error and says so.
   */
  it('refuses to open a challenge for an action the endpoint did not ask for', async () => {
    const attempt = async () => {
      throw Object.assign(new Error('nope'), {
        status: 403, data: { code: 'reauth_required', action: 'account.delete' }
      });
    };

    await expect(
      withStepUp(STEP_UP.DATA_EXPORT, {}, attempt, async () => 'never')
    ).rejects.toThrow(/asked to verify 'account\.delete' but the caller declared 'data\.export'/);
  });

  it('spends a grant already earned at a provider instead of asking again', async () => {
    saveReadyGrant({
      action: 'oauth.link',
      challengeId: 'reauth-ready',
      expiresAt: new Date(Date.now() + 120000).toISOString()
    });
    const open = vi.spyOn(api, 'openReauthChallenge');
    const attempt = vi.fn(async () => ({ ok: true }));

    await withStepUp(STEP_UP.OAUTH_LINK, { provider: 'google' }, attempt, async () => 'unused');

    expect(attempt).toHaveBeenCalledWith({ [REAUTH_CHALLENGE_HEADER]: 'reauth-ready' });
    expect(open, 'asked the user to verify something they had just verified').not.toHaveBeenCalled();
  });
});

describe('surviving the provider round trip', () => {
  it('reads the pending record once and then forgets it', () => {
    savePendingReauth({ provider: 'google', challengeId: 'c1', action: 'oauth.link', returnTo: '/settings' });

    expect(takePendingReauth()).toMatchObject({ provider: 'google', challengeId: 'c1' });
    // A callback that failed must not be replayable by reloading: each replay
    // would spend an attempt against the account ceiling with no user action.
    expect(takePendingReauth()).toBeNull();
  });

  it('survives a corrupted record rather than throwing on the screen that reads it', () => {
    sessionStorage.setItem('wev_reauth_pending', '{not json');
    expect(takePendingReauth()).toBeNull();
  });

  it('only returns a ready grant to the action it was earned for', () => {
    saveReadyGrant({
      action: 'account.delete', challengeId: 'c2',
      expiresAt: new Date(Date.now() + 120000).toISOString()
    });

    expect(takeReadyGrant('data.export'), 'handed one action\'s grant to another').toBeNull();
    expect(takeReadyGrant('account.delete')).toBe('c2');
  });

  it('is single use, because the grant is', () => {
    saveReadyGrant({
      action: 'account.delete', challengeId: 'c3',
      expiresAt: new Date(Date.now() + 120000).toISOString()
    });
    expect(takeReadyGrant('account.delete')).toBe('c3');
    expect(takeReadyGrant('account.delete')).toBeNull();
  });

  /**
   * Nearly-expired is treated as expired. Spending a grant with a second left
   * produces a 410 the user cannot act on; declining to spend it produces the
   * dialog again, which they can.
   */
  it('will not spend a grant that is about to die in transit', () => {
    saveReadyGrant({
      action: 'account.delete', challengeId: 'c4',
      expiresAt: new Date(Date.now() + 500).toISOString()
    });
    expect(takeReadyGrant('account.delete')).toBeNull();
  });

  it('treats a malformed expiry as unusable', () => {
    saveReadyGrant({ action: 'account.delete', challengeId: 'c5', expiresAt: 'not-a-date' });
    expect(takeReadyGrant('account.delete')).toBeNull();
  });

  /**
   * `sessionStorage`, never `localStorage`. A grant is bound to one sign-in and
   * lives five minutes, so it is worthless in another tab — but in
   * `localStorage` it would still be sitting on a shared school Chromebook after
   * the student had walked away.
   */
  it('keeps nothing in localStorage', () => {
    savePendingReauth({ provider: 'google', challengeId: 'c6', action: 'oauth.link' });
    saveReadyGrant({ action: 'oauth.link', challengeId: 'c6', expiresAt: new Date().toISOString() });

    const leaked = Object.keys(localStorage).filter(k => /reauth/i.test(k));
    expect(leaked).toEqual([]);
  });
});
