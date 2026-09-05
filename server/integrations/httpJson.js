/**
 * One outbound HTTPS request to a third-party operator API, with a deadline and
 * no way to throw.
 *
 * ── Why this exists rather than `fetch` at each call site ──
 *
 * Four providers, each with three or four endpoints, is a dozen places that
 * would otherwise each have to remember: a timeout (fetch has none of its own —
 * a socket that is accepted and then goes quiet hangs until the OS gives up),
 * a try/catch (a DNS failure is a thrown TypeError, and an unhandled rejection
 * inside a route handler is a 500 on a page whose whole job is to say what is
 * broken), and the rule that nothing from the wire may travel further in.
 *
 * The same argument `server/telemetrySink.js` makes for owning its own POST
 * rather than wrapping a vendor client, applied to reads.
 *
 * ── The Owner Center must never be slower than its slowest provider ──
 *
 * Each provider is fetched behind its own cache and its own request, so one
 * unreachable vendor costs one card rather than the page. The timeout here is
 * the backstop for that: it is short enough that a hung provider resolves as
 * `timeout` inside the reader's patience rather than at the client's 45-second
 * ceiling.
 */
import { classifyStatus, fail } from './providerResult.js';

/**
 * How long a provider has to answer.
 *
 * Deliberately generous compared to `server/redis/redisConfig.js`'s 800 ms, and
 * for the opposite reason: there, a caller has a correct answer available
 * without Redis and waiting is strictly worse than falling back. Here there is
 * no fallback except "unavailable", and these are analytics APIs that
 * legitimately take a second or two to aggregate. Six seconds is comfortably
 * above that and far below anything that would make the page feel hung, because
 * the cards render as they arrive.
 */
export const PROVIDER_TIMEOUT_MS = Number(process.env.OWNER_PROVIDER_TIMEOUT_MS) || 6000;

/**
 * How much of a response we are willing to read.
 *
 * A provider that answers with a gigabyte — a misconfigured export endpoint, a
 * proxy error page, a compromised host — must not be able to spend this
 * process's memory. Every payload these modules ask for is a few kilobytes;
 * anything past a megabyte is not the response we asked for.
 */
const MAX_BYTES = 1_000_000;

/**
 * @returns {{ ok: true, body: any } | { ok: false, state: string }}
 *   never throws, and on failure carries a state word and nothing from the wire.
 */
export async function fetchJson(url, { headers = {}, method = 'GET', body = null, timeoutMs = PROVIDER_TIMEOUT_MS, accept = 'application/json' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: accept, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    /* `TimeoutError` is what AbortSignal.timeout raises; everything else here
       is a transport failure (DNS, refused connection, TLS, an unexpected
       redirect). Neither carries anything worth keeping — `err.message` on a
       TLS failure names the host and the certificate, which is exactly the kind
       of detail this boundary exists to stop. */
    return fail(err?.name === 'TimeoutError' ? 'timeout' : 'unavailable');
  }

  /**
   * The numeric status travels with the failure; the BODY still does not.
   *
   * A caller occasionally needs to tell two failures apart in a way the state
   * word cannot express — Amplitude answers 400 for an event it has never
   * recorded, which is a fact about the data rather than a fault. A status code
   * is a number this repository generated no content for, so carrying it does
   * not weaken the rule in `providerResult.js`, which is about response
   * content. Nothing renders it.
   */
  if (!res.ok) return { ...fail(classifyStatus(res.status)), status: res.status };

  let text;
  try {
    text = await readCapped(res);
  } catch {
    return fail('bad_response');
  }
  if (text === null) return fail('bad_response');

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    /* A 200 that is not JSON is a captive portal, a proxy error page, or an API
       that changed shape. All three are the same instruction to the reader —
       the integration is not working — and none of them should put somebody
       else's HTML in front of the owner. */
    return fail('bad_response');
  }
}

/**
 * A response body as text, or `null` if it ran past the ceiling.
 *
 * Streamed rather than `res.text()`, because `text()` buffers the whole body
 * before anybody can object to its size — which makes a size limit checked
 * afterwards purely decorative.
 */
async function readCapped(res) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
