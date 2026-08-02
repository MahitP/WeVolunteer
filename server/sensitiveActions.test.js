import { describe, it, expect } from 'vitest';
import { SENSITIVE_ACTIONS, isSensitiveAction, paramsHash, canonicalParams } from './sensitiveActions.js';

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

// canonicalParams is exported specifically so these can be exercised directly:
// no current registry action binds 2+ params, so none of these properties can
// be observed by calling paramsHash with a real action name. Each of these
// four regression cases genuinely fails against the old `k=v&k=v`-join,
// String()-coercing encoding (see fix-report addendum for the before/after).
describe('canonicalParams (collision + ordering regressions)', () => {
  it('does not collide when a value contains the field delimiter', () => {
    // Old encoding: both dictionaries joined to the identical string
    // "a=X&b=Y&b=Z" because '&' and '=' inside a value are indistinguishable
    // from real field boundaries.
    const a = canonicalParams(['a', 'b'], { a: 'X&b=Y', b: 'Z' });
    const b = canonicalParams(['a', 'b'], { a: 'X', b: 'Y&b=Z' });
    expect(a).not.toBe(b);
  });

  it('distinguishes a bound key that is absent from one present but empty', () => {
    // Old encoding: `String(params?.[k] ?? '')` maps both undefined (absent)
    // and '' (present, empty) to the same '' token.
    expect(canonicalParams(['newEmail'], {})).not.toBe(canonicalParams(['newEmail'], { newEmail: '' }));
  });

  it('is independent of the order boundKeys are listed in', () => {
    // This is what .sort() actually guards. A black-box test through
    // paramsHash can't fail here even without .sort(), because JS property
    // lookup by name doesn't care what order an object literal's keys were
    // written in — this test instead varies the order of the *bindsParams
    // array itself*, which .sort() is what makes irrelevant.
    const params = { a: 'x', b: 'y' };
    expect(canonicalParams(['a', 'b'], params)).toBe(canonicalParams(['b', 'a'], params));
  });

  it('does not collide a numeric value with the string of the same digits', () => {
    // Old encoding: String(5) === String('5'), so a numeric and string bound
    // value hashed identically.
    expect(canonicalParams(['a'], { a: 5 })).not.toBe(canonicalParams(['a'], { a: '5' }));
  });
});
