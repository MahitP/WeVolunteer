import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createVerifier, challengeFor, authorizeParams } from './oauth/pkce.js';

/**
 * Provider credentials, set BEFORE anything reaching config.js is imported.
 *
 * `config.js` resolves every value at module scope, and `assertProviderConfigured`
 * refuses to mint an authorize URL without a client id and secret — correctly, it
 * is the guard that stopped the pilot minting `client_id=`. So the environment has
 * to exist before the first import that touches it.
 *
 * Every provider import in this file is therefore DYNAMIC (`await import`), and
 * the only static import above is `oauth/pkce.js`, which imports nothing but
 * `crypto`. `vitest.config.js` pins `isolate: true`, so this worker's module
 * registry is this file's alone and cannot inherit a config.js another suite
 * already evaluated.
 *
 * These are not real credentials and nothing here reaches a provider — the token
 * endpoint is stubbed in the ID-token block below.
 */
const CLIENT_ID = 'test-microsoft-client-id';
process.env.GOOGLE_CLIENT_ID = 'test-google-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.MICROSOFT_CLIENT_ID = CLIENT_ID;
process.env.MICROSOFT_CLIENT_SECRET = 'test-microsoft-secret';
process.env.MICROSOFT_TENANT_ID = 'common';
process.env.OAUTH_ALLOW_MOCK = 'false';

/**
 * PKCE, and the Microsoft ID-token checks that sit beside it.
 *
 * ── Why PKCE is here at all ──
 *
 * `OAUTH_REDIRECT_URI` points at the SPA, so the provider delivers the
 * authorization code to the BROWSER and the browser posts it to the API. The code
 * therefore exists briefly in a place the server does not control — a URL, the
 * history, anything that can read the address bar. The client secret alone does
 * not bind that code to the flow that requested it; PKCE does.
 *
 * These are unit tests over pure functions plus a provider's URL construction.
 * Nothing here talks to a provider, and nothing here can: an end-to-end
 * assertion would need a live Google or Entra tenant. What is checked is
 * everything that is decidable locally — the challenge derivation, that the
 * parameters actually reach the authorize URL, and that the ID-token claim checks
 * refuse what they are supposed to refuse.
 */

describe('the PKCE verifier and challenge', () => {
  it('produces a verifier inside RFC 7636 §4.1 length limits', () => {
    const verifier = createVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses only unreserved characters, so it survives a query string intact', () => {
    /* base64url, i.e. no `+`, `/` or `=`. A verifier containing any of those is
       one the provider receives differently from the one we hashed, and the
       failure arrives as an opaque `invalid_grant` at exchange time. */
    expect(createVerifier()).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createVerifier()));
    expect(seen.size).toBe(200);
  });

  /**
   * The single most common way to get PKCE wrong.
   *
   * `challengeFor` must be base64url of the RAW digest. Using the hex digest
   * produces a 64-character string that looks plausible, is accepted by the
   * authorize request, and fails only at the token exchange — with an error that
   * names neither PKCE nor the encoding.
   */
  it('derives the challenge as base64url of the raw SHA-256 digest, not the hex digest', () => {
    const verifier = 'a'.repeat(43);
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    const hexMistake = crypto.createHash('sha256').update(verifier).digest('hex');

    expect(challengeFor(verifier)).toBe(expected);
    expect(challengeFor(verifier)).not.toBe(hexMistake);
    expect(challengeFor(verifier)).toHaveLength(43);
  });

  it('is deterministic for a verifier and different for another', () => {
    const a = createVerifier();
    const b = createVerifier();
    expect(challengeFor(a)).toBe(challengeFor(a));
    expect(challengeFor(a)).not.toBe(challengeFor(b));
  });

  /**
   * S256 only. `plain` sends the verifier itself as the challenge, through the
   * same browser the code comes back through — which protects against nothing.
   * The module has no way to express it, and this is the assertion that keeps it
   * that way.
   */
  it('always declares S256 and never the verifier itself', () => {
    const verifier = createVerifier();
    const params = authorizeParams(verifier);
    expect(params.code_challenge_method).toBe('S256');
    expect(params.code_challenge).not.toBe(verifier);
    expect(Object.keys(params).sort()).toEqual(['code_challenge', 'code_challenge_method']);
  });
});

describe('the authorize URLs carry PKCE and the nonce', () => {
  /**
   * Asserted on the built URL, not on the call.
   *
   * `google.js` passes `code_challenge` through `generateAuthUrl`'s
   * pass-through-unknown-options behaviour, exactly as it already does for
   * `max_age`. A library upgrade that stopped forwarding unknown options would
   * break this silently, and the URL is the only place that shows it.
   */
  it('google sends the challenge, the method and the nonce', async () => {
    const google = (await import('./oauth/providers/google.js')).default;
    const verifier = createVerifier();
    const url = new URL(google.getAuthUrl('state-token', { codeVerifier: verifier, oidcNonce: 'nonce-abc' }));

    expect(url.searchParams.get('code_challenge')).toBe(challengeFor(verifier));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('nonce-abc');
    /* The verifier itself must never appear anywhere in the URL. */
    expect(url.toString()).not.toContain(verifier);
  });

  it('microsoft sends the challenge, the method and the nonce', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const verifier = createVerifier();
    const url = new URL(microsoft.getAuthUrl('state-token', { codeVerifier: verifier, oidcNonce: 'nonce-xyz' }));

    expect(url.searchParams.get('code_challenge')).toBe(challengeFor(verifier));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('nonce-xyz');
    expect(url.toString()).not.toContain(verifier);
  });

  /**
   * No verifier, no parameters — rather than empty ones.
   *
   * `code_challenge=` with no value is a request both providers reject, so
   * omitting is what keeps an authorization started before PKCE existed working
   * instead of failing at the authorize step.
   */
  it('omits the PKCE parameters entirely when there is no verifier', async () => {
    const google = (await import('./oauth/providers/google.js')).default;
    const url = new URL(google.getAuthUrl('state-token'));
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);
    expect(url.searchParams.has('nonce')).toBe(false);
  });

  /**
   * The scope Microsoft asks for, checked because it SHRANK.
   *
   * `User.Read` was requested only so the callback could read Graph `/me`. The
   * identity now comes from the ID token, so the scope would be a directory-read
   * consent prompt a district administrator would reasonably question, bought for
   * nothing.
   */
  it('microsoft asks for openid profile email and nothing more', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const url = new URL(microsoft.getAuthUrl('state-token', {}));
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('scope')).not.toContain('User.Read');
  });

  it('microsoft authorizes against the configured tenant', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const url = new URL(microsoft.getAuthUrl('state-token', {}));
    /* `common` is the default; a deployment that names its tenant gets that
       tenant in the authority, and `verifyCallback` re-checks the `tid` claim so
       the URL is not the only thing enforcing it. */
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
  });
});

/**
 * Microsoft's ID-token claim checks.
 *
 * Exercised through `verifyCallback` with a stubbed `fetch`, because the token
 * endpoint is the only external dependency and the checks under test are pure
 * claim comparisons. The signature is deliberately not verified — see the long
 * note on `verifyCallback`; these are the checks that catch misconfiguration
 * rather than forgery, and they are the ones worth pinning.
 */
describe('microsoft ID token validation', () => {
  const TID = '11111111-2222-3333-4444-555555555555';

  const jwtWith = (claims) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature-not-checked`;
  };

  const goodClaims = (over = {}) => ({
    aud: CLIENT_ID,
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    tid: TID,
    oid: 'oid-1',
    sub: 'pairwise-sub-1',
    name: 'Real Person',
    email: 'real.person@school.org',
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: 'the-nonce',
    ...over,
  });

  /** Stubs the token endpoint for one call and restores `fetch` afterwards. */
  async function verify(claims, opts = {}) {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ id_token: jwtWith(claims) }),
      text: async () => '',
    });
    try {
      return await microsoft.verifyCallback('an-authorization-code', opts);
    } finally {
      globalThis.fetch = original;
    }
  }

  it('accepts a well-formed token and takes the identity from its claims', async () => {
    const identity = await verify(goodClaims(), { expectedNonce: 'the-nonce' });
    expect(identity.email).toBe('real.person@school.org');
    expect(identity.name).toBe('Real Person');
    /* `oid`, the directory object id an administrator can look up — not the
       pairwise `sub`. */
    expect(identity.sub).toBe('oid-1');
  });

  /**
   * A Microsoft address is never treated as proven.
   *
   * `email` and `preferred_username` are directory attributes with no
   * proof-of-control claim behind them, and in a tenant the caller administers
   * both can be set to an arbitrary string — including a teacher's address.
   */
  it('never reports a Microsoft address as verified', async () => {
    const identity = await verify(goodClaims(), { expectedNonce: 'the-nonce' });
    expect(identity.emailVerified).toBe(false);
  });

  it('refuses a token minted for a different application', async () => {
    await expect(verify(goodClaims({ aud: 'someone-elses-client-id' })))
      .rejects.toThrow(/issued for a different application/);
  });

  it('refuses an unrecognised issuer', async () => {
    await expect(verify(goodClaims({ iss: 'https://evil.example/v2.0' })))
      .rejects.toThrow(/issuer is not recognised/);
  });

  it('refuses a token with no tenant claim', async () => {
    await expect(verify(goodClaims({ tid: undefined })))
      .rejects.toThrow(/issuer is not recognised/);
  });

  it('refuses an expired token', async () => {
    await expect(verify(goodClaims({ exp: Math.floor(Date.now() / 1000) - 60 })))
      .rejects.toThrow(/has expired/);
  });

  /**
   * The nonce binding. Audience validation proves the token was minted for this
   * application; it says nothing about WHICH sign-in produced it, so without this
   * a token captured from one of our own authorizations could be presented
   * against a different in-flight one.
   */
  it('refuses a token issued for a different sign-in attempt', async () => {
    await expect(verify(goodClaims({ nonce: 'a-different-nonce' }), { expectedNonce: 'the-nonce' }))
      .rejects.toThrow(/different sign-in attempt/);
  });

  it('refuses a token carrying no subject at all', async () => {
    await expect(verify(goodClaims({ oid: undefined, sub: undefined }), { expectedNonce: 'the-nonce' }))
      .rejects.toThrow(/no subject identifier/);
  });

  it('falls back to sub when oid is absent, as for a personal account', async () => {
    const identity = await verify(goodClaims({ oid: undefined }), { expectedNonce: 'the-nonce' });
    expect(identity.sub).toBe('pairwise-sub-1');
  });

  it('refuses a token that is not a well-formed JWT', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id_token: 'not-a-jwt' }), text: async () => '' });
    try {
      await expect(microsoft.verifyCallback('code', {})).rejects.toThrow(/not a well-formed JWT/);
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * A missing ID token is a configuration problem, and the message says so.
   *
   * It happens when the app registration does not request `openid`, which is a
   * five-second fix that is impossible to guess from "sign-in failed".
   */
  it('names the app registration when no ID token comes back', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'x' }), text: async () => '' });
    try {
      await expect(microsoft.verifyCallback('code', {})).rejects.toThrow(/openid scope/);
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * A failed exchange must not return the provider's body to the caller: it
   * carries AADSTS codes that name tenant configuration.
   */
  it('does not leak the provider error body to the client', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      text: async () => 'AADSTS50011: redirect URI does not match tenant contoso.onmicrosoft.com',
    });
    try {
      await microsoft.verifyCallback('code', {});
      throw new Error('should have refused');
    } catch (err) {
      expect(err.message).not.toContain('AADSTS50011');
      expect(err.message).not.toContain('contoso');
      expect(err.message).toMatch(/could not be completed/);
    } finally {
      globalThis.fetch = original;
    }
  });

  /** The verifier reaches the token endpoint, which is the half PKCE needs there. */
  it('sends the code_verifier in the token exchange', async () => {
    const microsoft = (await import('./oauth/providers/microsoft.js')).default;
    const original = globalThis.fetch;
    let sentBody = '';
    globalThis.fetch = async (_url, init) => {
      sentBody = String(init.body);
      return { ok: true, json: async () => ({ id_token: jwtWith(goodClaims()) }), text: async () => '' };
    };
    try {
      await microsoft.verifyCallback('code', { codeVerifier: 'the-verifier', expectedNonce: 'the-nonce' });
      expect(sentBody).toContain('code_verifier=the-verifier');
    } finally {
      globalThis.fetch = original;
    }
  });
});
