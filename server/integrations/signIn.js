/**
 * Google and Microsoft sign-in, and Cloudflare, for the Owner Center (SC-09).
 *
 * The owner asked for every external service to be checked from the Owner
 * Center. Google sign-in is the one that broke in production unnoticed — a 404
 * callback path and a redirect nobody had registered — so it is worth a card.
 *
 * ── What is asked, and what is never sent ──
 *
 * Each provider is asked for its PUBLIC OpenID discovery document. That proves
 * this server can reach the provider and that the provider is answering,
 * without sending a client id, a secret or a user's anything. Whether the
 * redirect URI is registered can only be learned by a real sign-in, and the
 * page says so rather than pretending to know.
 *
 * Like every Owner Center provider, a failure reduces to one state word here
 * (providerResult.js) and nothing from the response travels further.
 */
import { ok, fail, notConfigured, classifyStatus } from './providerResult.js';
import {
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
} from '../config.js';

const DISCOVERY = {
  google: 'https://accounts.google.com/.well-known/openid-configuration',
  microsoft: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
};

/** One provider: configured, and answering its discovery document. */
export async function checkSignInProvider({ configured, configureWith, discoveryUrl, fetchImpl = fetch, timeoutMs = 4000 }) {
  if (!configured) return notConfigured(configureWith);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(discoveryUrl, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return fail(classifyStatus(res.status));
    const doc = await res.json().catch(() => null);
    if (!doc || typeof doc.issuer !== 'string') return fail('bad_response');
    return ok({ reachable: true });
  } catch (err) {
    return fail(err?.name === 'AbortError' ? 'timeout' : 'unavailable');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSignInProviders() {
  const [google, microsoft] = await Promise.all([
    checkSignInProvider({
      configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      configureWith: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      discoveryUrl: DISCOVERY.google,
    }),
    checkSignInProvider({
      configured: Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET),
      configureWith: 'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET',
      discoveryUrl: DISCOVERY.microsoft,
    }),
  ]);
  return { google, microsoft };
}

/**
 * Whether the request that asked came through Cloudflare, and through which
 * data centre — read from the `CF-Ray` header Cloudflare adds to every request
 * it proxies (`<id>-<colo>`). Contacts nothing. nginx admits only Cloudflare's
 * addresses (wevolunteer-cf-ip-refresh), so on production the header is
 * Cloudflare's own; on a development machine there is none, and the card says
 * "not proxied", which is true there.
 */
export function cloudflareStatus(req) {
  const ray = String(req?.headers?.['cf-ray'] || '');
  const colo = ray.includes('-') ? ray.split('-').pop().toUpperCase() : null;
  return ok({ proxied: Boolean(ray), colo: ray ? colo : null });
}
