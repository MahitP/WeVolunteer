import crypto from 'crypto';

/**
 * Every action that requires a fresh proof of identity, in one place.
 *
 * A registry rather than a check at each call site, because the failure mode of
 * scattered checks is silent omission: the endpoint that forgets its gate looks
 * exactly like the endpoint that never needed one. Before this module, four
 * endpoints each did their own inline bcrypt.compare and a fifth
 * (POST /api/privacy/export, bulk PII egress) did none at all.
 *
 * `bindsParams` lists the request fields folded into the grant. Without it,
 * verifying in order to change your email to a@x.com would also authorise
 * changing it to attacker@x.com inside the same five-minute window — the subtle
 * bug in most step-up implementations.
 */
export const SENSITIVE_ACTIONS = {
  'account.delete':   { label: 'delete your account',            methods: ['password', 'oauth'], bindsParams: [] },
  'password.change':  { label: 'change your password',           methods: ['password', 'oauth'], bindsParams: [] },
  'email.change':     { label: 'change your email address',      methods: ['password', 'oauth'], bindsParams: ['newEmail'] },
  'oauth.link':       { label: 'connect a sign-in provider',     methods: ['password', 'oauth'], bindsParams: ['provider'] },
  /**
   * Removing a credential is a credential change, exactly as adding one is.
   *
   * `oauth.link` was gated from the start and this was not, which left the
   * rule the guide states — adding a sign-in credential requires proving
   * identity — true of only one direction. The v1.2b plan did examine
   * `disconnect`, but judged it against LOCKOUT ("never leave an account with
   * no way back in") rather than assurance; that guard stops a user stranding
   * themselves and does nothing about a borrowed session stripping a provider
   * off an account that still has a password. Binds `provider` so a grant
   * removes ONE named credential, mirroring `oauth.link`.
   */
  'oauth.unlink':     { label: 'disconnect a sign-in provider',  methods: ['password', 'oauth'], bindsParams: ['provider'] },
  'data.export':      { label: 'export all of your data',        methods: ['password', 'oauth'], bindsParams: [] },
  /**
   * Retrieving the archive, which is where the data actually leaves.
   *
   * `data.export` gates the REQUEST; this gates the DISCLOSURE. Gating only
   * the former protected an archive that did not exist yet and left the
   * finished one — seven days of it — behind nothing but a session.
   *
   * Separate from `data.export` rather than reused, for three reasons: a grant
   * must prove identity for ONE action, and queuing a new export is not the
   * same act as pulling an existing one down; `jobId` can be bound here, so a
   * verification authorises exactly one archive; and the user is shown "download
   * your data archive" instead of "export all of your data" at the moment they
   * are doing the former.
   */
  'data.download':    { label: 'download your data archive',     methods: ['password', 'oauth'], bindsParams: ['jobId'] },
  /**
   * Reading the private message bodies a safety report preserved.
   *
   * ── Why this belongs here, and why it was the glaring omission ──
   *
   * Every other action in this registry is about the ACTOR's own account:
   * deleting it, changing its password or address, connecting a provider,
   * exporting its data. This one is about somebody else's private messages, and
   * that somebody is usually a minor. Downloading your own data archive required
   * a fresh verification; reading a child's messages required a session.
   *
   * The read was already logged twice and to two trails, one of them exempt from
   * retention — the accountability was in place. What was missing was the moment
   * of deliberation: a step-up turns an idle click on "Show the messages" into an
   * act somebody has to mean.
   *
   * ── Binds `reportId` ──
   *
   * So one verification opens one report's evidence and not the queue. Without
   * the binding, a moderator who verified to read one report would hold a
   * five-minute key to every child's messages on the platform, which is a
   * strictly worse position than the one this replaced.
   *
   * ── The friction is real and is the point ──
   *
   * Five minutes, one report. During an active incident that is one password
   * entry before reading the thing that decides whether to suspend somebody. The
   * alternative was that the most invasive read on the platform was also the
   * cheapest.
   */
  'report.evidence':  { label: 'read the messages this report preserved', methods: ['password', 'oauth'], bindsParams: ['reportId'] },
  /**
   * Inviting an administrator (IV-1).
   *
   * A pending invitation is administrator authority awaiting collection, so
   * creating one is at least as consequential as promoting an existing account —
   * and unlike a promotion it can be sent to somebody the platform has never
   * seen. Binds `email` so one verification invites one person.
   */
  'admin.invite':     { label: 'invite an administrator',         methods: ['password', 'oauth'], bindsParams: ['email'] },
  'admin.promote':    { label: 'promote an administrator',       methods: ['password', 'oauth'], bindsParams: ['targetUserId'] },
  'admin.revoke':     { label: 'revoke an administrator',        methods: ['password', 'oauth'], bindsParams: ['targetUserId'] },
  /**
   * Modifying 2FA changes the security posture of an account. It requires a fresh verification
   * to ensure an attacker with a hijacked session cannot quietly add a backdoor or disable 2FA.
   */
  '2fa.generate':     { label: 'set up two-factor authentication', methods: ['password', 'oauth'], bindsParams: [] },
  '2fa.enable':       { label: 'enable two-factor authentication', methods: ['password', 'oauth'], bindsParams: [] },
  '2fa.disable':      { label: 'disable two-factor authentication', methods: ['password', 'oauth'], bindsParams: [] },
  /**
   * Replacing recovery codes has its OWN action, and is not `2fa.enable`.
   *
   * It used to share it, and that made one grant fungible across three
   * different effects. The dialog a user answers says "enable two-factor
   * authentication"; the grant it produced was spendable, unaltered, on the
   * handler whose first statement is `DELETE FROM recovery_codes` — destroying
   * the one credential the product tells people is their only way back in.
   *
   * That was concretely reachable rather than theoretical: enrolling an
   * authenticator opens `2fa.generate` and `2fa.enable` from a single password
   * entry and holds the unspent `2fa.enable` grant in client state for up to
   * five minutes while the user scans a QR code.
   *
   * The same asymmetry `oauth.unlink` was registered to close — removing a
   * credential is a credential change, exactly as adding one is — and the same
   * remedy: its own name, so the sentence in the dialog is the operation the
   * grant can be spent on.
   */
  '2fa.recovery.regenerate': {
    label: 'replace your recovery codes', methods: ['password', 'oauth'], bindsParams: []
  },
};

export function isSensitiveAction(action) {
  return Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, action);
}

/**
 * Where a request declares the re-verification it is spending.
 *
 * ── Why a header rather than a body field ──
 *
 *   1. Two of the seven sensitive actions are reached by methods that carry no
 *      body at all — account deletion is a DELETE, and collecting a data export
 *      is a GET — so a mechanism riding in the body works for five of seven and
 *      is one someone will forget on the other two. The download is the sharper
 *      case of the two: it has no body to put a field in even in principle,
 *      which is also why the browser navigation it used to be could not be
 *      gated where it stood.
 *   2. `authenticateToken` would otherwise depend on the body parser having
 *      already run. It does today, but that is an ordering fact in app.js, and
 *      the middleware that decides assurance should not be the thing that
 *      breaks when the ordering is edited.
 *   3. The challenge id is transport metadata about the request, not an
 *      argument to it. Keeping it out of the body keeps it out of the object
 *      whose fields `paramsHash` binds, so it can never be mistaken for one.
 *
 * Node lower-cases incoming header names, so the wire form is only ever used
 * by clients and documentation. A duplicated header arrives comma-joined,
 * which matches no challenge id and resolves to AAL1 — the safe direction.
 *
 * ── Why it lives HERE and not in utils.js, where it started ──
 *
 * `utils.js` reaches `db.js` at module scope, so nothing in the client bundle
 * can import from it — the browser half of this feature would have had to
 * retype the wire name. Two spellings of a header is one typo away from a
 * client that presents its grant to a server that never looks for it: the
 * request silently resolves to AAL1 and the sensitive action answers
 * `reauth_required`, sending the UI back to the verification modal it has just
 * come from, for ever. This module imports only `node:crypto`, is already the
 * shared vocabulary of step-up (the action names and their labels), and is what
 * `src/authz.js`'s mirror pattern makes reachable from the client. One
 * definition, both sides; `sensitiveActions.test.js` fails the build on a
 * second one.
 */
export const REAUTH_CHALLENGE_HEADER = 'X-Reauth-Challenge';

/**
 * Canonical, collision-free encoding of one action's bound params.
 *
 * Exported on its own (not inlined in paramsHash) because no current
 * registry entry binds more than one param — `oauth.link` binds just
 * `provider` — so none of the properties below can be exercised by calling
 * paramsHash with a real action name. Tests call this directly with a
 * synthetic multi-key boundKeys list instead.
 *
 * Encodes each bound key as a `[key, value]` pair, sorted by key, then
 * JSON.stringifies the whole array:
 *  - `JSON.stringify` escapes quotes and separators inside string values, so
 *    a value containing '&' or '=' can't forge a field boundary. The
 *    previous `k=v&k=v` join could not tell `{a:'X&b=Y', b:'Z'}` apart from
 *    `{a:'X', b:'Y&b=Z'}` — both joined to the same string.
 *  - Absence is tagged by array *shape*, not by a value that a real value
 *    could also be: an absent key encodes as the 2-element `['absent', k]`;
 *    a present key encodes as the 3-element `['present', k, value]`. No
 *    legal JSON value can widen a 2-element array into a 3-element one, so
 *    a bound key explicitly sent as `null` (`{"newEmail": null}` is valid,
 *    parseable JSON) can never collide with that key being missing
 *    entirely. An earlier version of this function used bare `null` as the
 *    absent-key sentinel — that collided with both "sent empty string" and,
 *    worse, with a key genuinely present with value `null`; the tagged
 *    shape closes both.
 *  - Values otherwise keep their native JSON type instead of being coerced
 *    with String(). A bound field arrives from a parsed JSON request body,
 *    so it is always a string, number, boolean, null, or absent — never a
 *    JS-only type like bare `undefined` that JSON can't represent — so
 *    keeping the type is free and means the numeric `5` and the string `'5'`
 *    hash differently instead of colliding the way `String(5) === String('5')`
 *    would. Caveat: JSON.stringify still maps NaN/Infinity to `null` in
 *    array position, so a *present* NaN value would still collide with a
 *    present literal-null value. Not reachable from a JSON-parsed request
 *    body (JSON has no NaN/Infinity literal) — worth naming for a future
 *    programmatic caller, not worth validating against here.
 *  - `.sort()` on boundKeys makes the *order the bindsParams array lists
 *    its keys in* irrelevant. (Key order within the request body's own
 *    object literal was never relevant — JS property lookup is by name —
 *    so that was never the risk; this guards the array in the registry.)
 */
export function canonicalParams(boundKeys, params) {
  const source = params ?? {};
  return JSON.stringify(
    boundKeys
      .slice()
      .sort()
      .map(k => (Object.prototype.hasOwnProperty.call(source, k) ? ['present', k, source[k]] : ['absent', k])),
  );
}

/** Canonical hash of the bound params. Key order must not matter; values must. */
export function paramsHash(action, params = {}) {
  if (!isSensitiveAction(action)) throw new Error(`Unknown sensitive action: ${action}`);
  const bound = SENSITIVE_ACTIONS[action].bindsParams;
  const canonical = canonicalParams(bound, params);
  return crypto.createHash('sha256').update(`${action}|${canonical}`).digest('hex');
}
