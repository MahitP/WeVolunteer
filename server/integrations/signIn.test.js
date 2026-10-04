import { describe, it, expect, vi } from 'vitest';
import { checkSignInProvider, cloudflareStatus } from './signIn.js';

/**
 * Sign-in providers and Cloudflare in the Owner Center (SC-09).
 *
 * The owner asked for every external service to be checked from the Owner
 * Center. Upstash, Pinecone, Better Stack and Amplitude were; Google and
 * Microsoft sign-in and Cloudflare were not — and Google sign-in is the one
 * that broke in production with nobody told (a 404 path and an unregistered
 * redirect). These answer the questions an owner can act on: is it set up, can
 * this server reach the provider, is traffic coming through Cloudflare.
 *
 * The provider check reads the PUBLIC discovery document, so no credential is
 * ever sent, and like every Owner Center provider it reduces to a state word —
 * nothing from a vendor response travels further.
 */
const DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';

describe('checkSignInProvider', () => {
  it('names the variables to set when it is not configured', async () => {
    const r = await checkSignInProvider({ configured: false, configureWith: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET', discoveryUrl: DISCOVERY, fetchImpl: vi.fn() });
    expect(r).toEqual({ state: 'not_configured', configureWith: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET' });
  });

  it('is ok when the provider answers its discovery document', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://accounts.google.com', authorization_endpoint: 'x' }) }));
    const r = await checkSignInProvider({ configured: true, configureWith: 'X', discoveryUrl: DISCOVERY, fetchImpl });
    expect(r.state).toBe('ok');
    expect(r.reachable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(DISCOVERY, expect.anything());
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/secret|client_id/i);
  });

  it('reduces a failure to a word, and repeats nothing the provider said', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'upstream secret detail', json: async () => ({ error: 'secret' }) }));
    const r = await checkSignInProvider({ configured: true, configureWith: 'X', discoveryUrl: DISCOVERY, fetchImpl });
    expect(r.state).toBe('unavailable');
    expect(JSON.stringify(r)).not.toMatch(/secret/);
  });

  it('says timeout when the provider does not answer in time', async () => {
    const fetchImpl = vi.fn((url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const r = await checkSignInProvider({ configured: true, configureWith: 'X', discoveryUrl: DISCOVERY, fetchImpl, timeoutMs: 20 });
    expect(r.state).toBe('timeout');
  });
});

describe('cloudflareStatus', () => {
  it('reads whether this request came through Cloudflare, and where', () => {
    expect(cloudflareStatus({ headers: { 'cf-ray': '8c1f2a3b4c5d6e7f-IAD' } })).toEqual({ state: 'ok', proxied: true, colo: 'IAD' });
    expect(cloudflareStatus({ headers: {} })).toEqual({ state: 'ok', proxied: false, colo: null });
  });
});
