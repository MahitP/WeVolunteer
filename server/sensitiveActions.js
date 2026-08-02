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
  'data.export':      { label: 'export all of your data',        methods: ['password', 'oauth'], bindsParams: [] },
};

export function isSensitiveAction(action) {
  return Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, action);
}

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
