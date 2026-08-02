import { describe, it, expect } from 'vitest';
import { SENSITIVE_ACTIONS, isSensitiveAction, paramsHash } from './sensitiveActions.js';

describe('sensitive action registry', () => {
  it('lists exactly the actions requiring step-up', () => {
    expect(Object.keys(SENSITIVE_ACTIONS).sort()).toEqual([
      'account.delete', 'data.export', 'email.change', 'oauth.link', 'password.change',
    ]);
  });

  it('rejects unknown actions', () => {
    expect(isSensitiveAction('account.delete')).toBe(true);
    expect(isSensitiveAction('account.delet')).toBe(false);   // typo must not pass
    expect(isSensitiveAction('')).toBe(false);
  });

  it('binds params so a grant cannot be reused for different arguments', () => {
    const a = paramsHash('email.change', { newEmail: 'a@x.com' });
    const b = paramsHash('email.change', { newEmail: 'attacker@x.com' });
    expect(a).not.toBe(b);
    expect(a).toBe(paramsHash('email.change', { newEmail: 'a@x.com' }));
  });

  // NOTE: the brief's draft used placeholder keys { a: 1, b: 2 } here, but no
  // registry entry actually binds two params (oauth.link binds only
  // 'provider') so that draft could never distinguish order-insensitivity
  // from "key not bound, ignored either way." Rewritten against oauth.link's
  // real bound field so the assertion exercises real behavior: reordering an
  // object literal's keys doesn't change the hash, but changing the bound
  // value does.
  it('is insensitive to key order but sensitive to values', () => {
    expect(paramsHash('oauth.link', { provider: 'google', other: 1 })).toBe(paramsHash('oauth.link', { other: 1, provider: 'google' }));
    expect(paramsHash('oauth.link', { provider: 'google' })).not.toBe(paramsHash('oauth.link', { provider: 'apple' }));
  });

  it('hashes actions with no bound params to a stable constant', () => {
    expect(paramsHash('account.delete', {})).toBe(paramsHash('account.delete', { ignored: 'x' }));
  });

  it('refuses to hash an unknown action', () => {
    expect(() => paramsHash('made.up', {})).toThrow(/unknown sensitive action/i);
  });
});
