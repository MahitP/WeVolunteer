import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import {
  SENSITIVE_ACTIONS, isSensitiveAction, paramsHash, canonicalParams, REAUTH_CHALLENGE_HEADER
} from './sensitiveActions.js';

describe('sensitive action registry', () => {
  /**
   * Spelled out rather than derived, so adding an action is a deliberate act a
   * reviewer sees. `data.download` and `oauth.unlink` joined the list in the
   * v1.2b audit round: the first because gating the export REQUEST protected an
   * archive that did not exist yet while leaving the finished one behind a bare
   * session for seven days, the second because `oauth.link` was gated and the
   * operation that removes the same credential was not.
   *
   * `report.evidence` joined in the v1.2c privacy review, and it is the entry
   * that exposes what the rest of this list had in common: every other action
   * here is about the ACTOR's own account. This one is about somebody else's
   * private messages, and that somebody is usually a minor. Downloading your own
   * data archive required a fresh verification while reading a child's messages
   * required only a session.
   */
  it('lists exactly the actions requiring step-up', () => {
    expect(Object.keys(SENSITIVE_ACTIONS).sort()).toEqual([
      'account.delete', 'admin.invite', 'admin.promote', 'admin.revoke', 'data.download', 'data.export', 'email.change',
      'oauth.link', 'oauth.unlink', 'password.change', 'report.evidence',
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

  /**
   * The action name is folded into the digest, so two actions that bind NO
   * params still hash differently.
   *
   * ── Why this needs its own test (v1.2b audit, F-4) ──
   *
   * Every other assertion here compares hashes WITHIN one action, so none of
   * them can observe the `${action}|` prefix at all: deleting it from
   * `paramsHash` left the whole suite green. The property survived only because
   * `consumeChallenge` also carries a redundant `AND action = ?` predicate,
   * which masks the loss.
   *
   * That redundancy is deliberate, but `reauth.js` states the dependency the
   * other way round — "the two are only equivalent for as long as paramsHash
   * keeps hashing `${action}|...`, and nothing in that module promises the
   * binding it is providing here." This is that promise. Without it, a later
   * simplification that removed EITHER half would be silent, and three of the
   * five registered actions bind nothing, so their grants would become
   * interchangeable: a verification collected to export your data would hash
   * identically to one collected to delete your account.
   */
  it('separates two actions that bind no params at all', () => {
    const zeroParam = Object.keys(SENSITIVE_ACTIONS)
      .filter(a => SENSITIVE_ACTIONS[a].bindsParams.length === 0);
    expect(zeroParam.length).toBeGreaterThan(1);

    const hashes = zeroParam.map(a => paramsHash(a, {}));
    expect(new Set(hashes).size).toBe(zeroParam.length);

    // Named explicitly as well, so the intent survives a registry change that
    // happens to leave only one zero-param action behind.
    expect(paramsHash('account.delete', {})).not.toBe(paramsHash('data.export', {}));
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

  it('distinguishes an explicit JSON null from a bound key being absent', () => {
    // { newEmail: null } is valid, parseable JSON, so this is reachable from
    // a real request body. The [key, value]-pair encoding used `null` as the
    // absent-key sentinel, so a present key whose *value* is literal `null`
    // hashed identically to that key being missing entirely.
    expect(canonicalParams(['newEmail'], {})).not.toBe(canonicalParams(['newEmail'], { newEmail: null }));
  });
});

/**
 * The challenge header's one home.
 *
 * It started in `server/utils.js`, which reaches `db.js` at module scope — so
 * the client could not import it and would have had to retype the wire name.
 * Two spellings of a header is one typo away from a client that presents its
 * grant to a server that never looks for it: every request silently resolves to
 * AAL1 and every sensitive action 403s with `reauth_required` in a loop the
 * user cannot break. This module is pure and already the shared vocabulary for
 * step-up, so the constant lives here and utils.js imports it.
 */
describe('the reauth challenge header', () => {
  it('is the wire name the client and the server both use', () => {
    expect(REAUTH_CHALLENGE_HEADER).toBe('X-Reauth-Challenge');
  });

  it('is defined in exactly one place across server/', () => {
    const files = [];
    const walk = (dirUrl, rel) => {
      for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          walk(new URL(`${entry.name}/`, dirUrl), `${rel}${entry.name}/`);
        } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
          files.push({ url: new URL(entry.name, dirUrl), key: `server/${rel}${entry.name}` });
        }
      }
    };
    walk(new URL('./', import.meta.url), '');
    expect(files.length, 'the server/ walk found no modules to scan').toBeGreaterThan(0);

    // The literal, not the identifier: a second `export const … = 'X-Reauth-Challenge'`
    // is the drift this guards, and importing the constant leaves no literal behind.
    const definers = files.filter(f => readFileSync(f.url, 'utf8').includes("'X-Reauth-Challenge'"));
    expect(definers.map(f => f.key)).toEqual(['server/sensitiveActions.js']);
  });
});
