import { setMailTransportForTests } from './email.js';

/**
 * A mailbox for tests, so they can read a token the way a user does.
 *
 * ── Why this exists ──
 *
 * Six test files used to get a verification or reset token by reading it out of
 * the database: `SELECT token FROM password_reset_tokens WHERE user_id = ?`.
 * Migration 048 replaced those plaintext columns with a SHA-256 digest, so that
 * is no longer possible — which is the entire point of the migration. Nothing
 * can recover a usable credential from the table, including the test suite.
 *
 * The alternative would have been a test-only way to mint a token, and it would
 * have been worse in two ways. It would not be the token the route actually
 * sent, so a route that issued one thing and mailed another would still pass.
 * And several of these cases are specifically about supersession — "asking again
 * invalidates the previous link" — which a helper that mints a fresh token
 * cannot express at all, because minting is the thing under test.
 *
 * So the tests now do what a person does: open the email and follow the link.
 * That covers strictly more than the old approach — it proves the token reached
 * the message, that the URL is built correctly, and that the link works.
 *
 * ── Why polling ──
 *
 * Several senders are deliberately fire-and-forget: `sendVerificationMail`
 * catches and logs rather than making a slow mail server turn a successful
 * signup into a 500. So the message can land a tick or two after the HTTP
 * response. `waitFor` polls briefly rather than assuming, and fails with a
 * readable message rather than returning undefined and letting the assertion
 * fail somewhere confusing.
 */

/** Parses `?verify=…`, `?reset=…`, `?emailchange=…` out of a message body. */
function tokenFromBody(body, param) {
  if (!body) return null;
  const m = String(body).match(new RegExp(`[?&]${param}=([^&"'\\s<)]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Installs a capturing transport. Call in `beforeAll`, and `restore()` in
 * `afterAll` so a later file does not inherit it.
 */
export function installMailbox() {
  const messages = [];

  setMailTransportForTests({
    sendMail: async (mail) => {
      messages.push(mail);
      return { messageId: `test-mailbox-${messages.length}` };
    },
  });

  const matching = (predicate) => messages.filter(predicate);

  const api = {
    messages,

    /** Forget everything so far, so the next assertion cannot read a stale message. */
    clear() { messages.length = 0; },

    /** Every message sent to an address, oldest first. */
    to(address) {
      const wanted = String(address).toLowerCase();
      return matching((m) => String(m.to || '').toLowerCase().includes(wanted));
    },

    /** The most recent message to an address. */
    lastTo(address) {
      const found = api.to(address);
      return found.length ? found[found.length - 1] : null;
    },

    /**
     * The token carried by the most recent message to an address.
     *
     * @param {string} address
     * @param {'verify'|'reset'|'emailchange'} param  the query parameter to read
     */
    tokenFor(address, param) {
      const mail = api.lastTo(address);
      if (!mail) return null;
      return tokenFromBody(mail.text, param) ?? tokenFromBody(mail.html, param);
    },

    /** Polls until a token arrives, because several senders do not await. */
    async waitForToken(address, param, { timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const token = api.tokenFor(address, param);
        if (token) return token;
        if (Date.now() > deadline) {
          throw new Error(
            `No "${param}" token mailed to ${address} within ${timeoutMs}ms. `
            + `Messages seen: ${messages.map((m) => `${m.to}: ${m.subject}`).join(' | ') || '(none)'}`
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    /** Polls until a message reaches an address, for cases that assert on the message itself. */
    async waitFor(address, { timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const mail = api.lastTo(address);
        if (mail) return mail;
        if (Date.now() > deadline) {
          throw new Error(`No mail to ${address} within ${timeoutMs}ms.`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    restore() { setMailTransportForTests(null); },
  };

  return api;
}
