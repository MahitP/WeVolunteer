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

/** Canonical hash of the bound params. Key order must not matter; values must. */
export function paramsHash(action, params = {}) {
  if (!isSensitiveAction(action)) throw new Error(`Unknown sensitive action: ${action}`);
  const bound = SENSITIVE_ACTIONS[action].bindsParams;
  const canonical = bound
    .slice()
    .sort()
    .map(k => `${k}=${String(params?.[k] ?? '')}`)
    .join('&');
  return crypto.createHash('sha256').update(`${action}|${canonical}`).digest('hex');
}
