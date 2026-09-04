import { describe, it, expect } from 'vitest';
import {
  RESERVED_HANDLES, HANDLE_MIN, HANDLE_MAX,
  normaliseHandle, validateHandle, handlePath, isHandleForm,
} from './organizationHandles.js';
import { CLIENT_ROUTE_PATTERNS } from './clientRoutes.js';

/**
 * The rules behind `/organizations/@robotics`.
 *
 * ── Why the reserved list is the subject of half this file ──
 *
 * Before this module existed, a club named "New" was created with the handle
 * `new` and a permanently unreachable page: the router matches the literal
 * `/organizations/new` first, so the create form rendered instead of the club.
 * Nothing reported it. That is a real defect that shipped, and these assertions
 * are what stop it coming back — including the one that proves the list is
 * DERIVED from the route table rather than typed out, because a typed list
 * would go stale the day somebody adds `/organizations/settings`.
 */

describe('the reserved list', () => {
  it('is derived from the route patterns the build already keeps in step', () => {
    /* Recomputed here from the same source, so this fails if the derivation is
       ever replaced by a hardcoded array — which would then be a second copy
       that can disagree with the router. */
    const expected = [...new Set(
      CLIENT_ROUTE_PATTERNS
        .map(pattern => pattern.split('/').filter(Boolean))
        .filter(parts => parts[0] === 'organizations' && parts.length > 1)
        .map(parts => parts[1])
        .filter(segment => !segment.startsWith(':')),
    )].sort();

    expect(RESERVED_HANDLES).toEqual(expected);
  });

  it('covers the two literals that actually collide today', () => {
    expect(RESERVED_HANDLES).toContain('new');
    expect(RESERVED_HANDLES).toContain('invite');
  });

  /* `edit` is a SECOND segment, so a handle can never be read in its place —
     and reserving it would refuse a club perfectly reasonably called "Edit". */
  it('does not reserve a second-segment literal', () => {
    expect(RESERVED_HANDLES).not.toContain('edit');
  });

  it('refuses every reserved word, whatever the case or sigil', () => {
    for (const reserved of RESERVED_HANDLES) {
      for (const written of [reserved, reserved.toUpperCase(), `@${reserved}`]) {
        const result = validateHandle(written);
        expect(result.ok, `${written} should be refused`).toBe(false);
        expect(result.error).toMatch(/reserved/);
      }
    }
  });
});

describe('normalising what somebody typed', () => {
  it('strips the @, which is punctuation and never stored', () => {
    expect(normaliseHandle('@robotics')).toBe('robotics');
    expect(normaliseHandle('@@robotics')).toBe('robotics');
    expect(normaliseHandle('robotics')).toBe('robotics');
  });

  it('lowercases and trims, so one handle has one spelling', () => {
    expect(normaliseHandle('  @Robotics  ')).toBe('robotics');
  });

  it('answers an empty string for nothing at all', () => {
    for (const nothing of [undefined, null, '', '   ', '@']) {
      expect(normaliseHandle(nothing)).toBe('');
    }
  });
});

describe('validating a handle', () => {
  it('accepts the ordinary shapes', () => {
    for (const good of ['robotics', 'nhs-2', 'chess-club', 'a1b2', 'community-garden-crew']) {
      expect(validateHandle(good), good).toEqual({ ok: true, value: good });
    }
  });

  it('accepts the @ form and stores it bare', () => {
    expect(validateHandle('@Chess-Club')).toEqual({ ok: true, value: 'chess-club' });
  });

  it('asks for one rather than refusing an empty field silently', () => {
    const result = validateHandle('');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Choose a web address/);
  });

  it('holds the length bounds', () => {
    expect(validateHandle('a'.repeat(HANDLE_MIN - 1)).ok).toBe(false);
    expect(validateHandle('a'.repeat(HANDLE_MIN)).ok).toBe(true);
    expect(validateHandle('a'.repeat(HANDLE_MAX)).ok).toBe(true);
    expect(validateHandle('a'.repeat(HANDLE_MAX + 1)).ok).toBe(false);
  });

  /**
   * Starting with a letter, which is the same rule `validateUsername` applies.
   *
   * Every id in this schema is `<prefix>-<random>` and several are all digits
   * after the prefix. A handle that could look like an id is a handle somebody
   * will mistake for one.
   */
  it('requires a letter first', () => {
    for (const bad of ['2fast', '-robotics', '9', '1-club']) {
      expect(validateHandle(bad).ok, bad).toBe(false);
    }
  });

  it('refuses everything that is not a letter, a digit or a single hyphen', () => {
    for (const bad of [
      'chess club', 'chess_club', 'chess.club', 'chess/club', 'chess@club',
      'chess--club', 'chess-', 'chess%20club', 'chess\nclub', 'chesś',
    ]) {
      expect(validateHandle(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  /**
   * A path separator in a handle would be a path, and the canonical route is
   * one segment. Belt and braces: the route table cannot match a second
   * segment here either.
   */
  it('refuses anything that would change the shape of the URL', () => {
    for (const bad of ['../admin', 'a/b', 'a?b=1', 'a#b', 'a%2Fb', 'robotics/edit']) {
      expect(validateHandle(bad).ok, bad).toBe(false);
    }
  });

  /**
   * The shape that used to slip through, and the exploit it enabled.
   *
   * An organization id is `org-` plus a `crypto.randomUUID()` — exactly 40
   * characters, starts with a letter, lowercase alphanumerics separated by
   * single hyphens. It satisfied every other rule here, and this module's own
   * comment claimed it could not.
   *
   * With `loadOrganization` resolving a key against `slug` OR `id`, a manager
   * of any club could read another club's id off the directory payload, claim
   * it as their own handle, and shadow the victim on every id-addressed path —
   * so the victim's members following a legacy notification link landed on the
   * attacker's page, and on an `open` club their Join press put them on a
   * stranger's roster.
   */
  it('refuses a handle that could be an internal id', () => {
    for (const id of [
      'org-4a30e1d4-0191-4694-81e2-d715926a5817',
      'usr-fb962375-7a54-4847-bbfe-da2fbb8036d5',
      'x-9645e89c-386e-41a3-9ced-7652c30b5bef',
    ]) {
      const result = validateHandle(id);
      expect(result.ok, id).toBe(false);
      /* Not "reserved" — nobody wanted this word. */
      expect(result.error).toMatch(/not available/);
    }
  });

  /* A bare UUID is refused one rule earlier, because it starts with a digit.
     Asserted separately so the two refusals are not conflated: this one would
     still be refused if `ID_SHAPED` were deleted, and the three above would
     not. */
  it('refuses a bare UUID for its shape', () => {
    const result = validateHandle('9645e89c-386e-41a3-9ced-7652c30b5bef');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/starting with a letter/);
  });

  /**
   * Written for a UUID rather than for the `org-` prefix, so it covers every id
   * shape this schema uses instead of only the one that was found.
   */
  it('refuses an id shape it has never seen', () => {
    expect(validateHandle('team-4a30e1d4-0191-4694-81e2-d715926a5817').ok).toBe(false);
  });

  /** And does not refuse a club whose name happens to contain hex and digits. */
  it('still accepts an ordinary handle that looks technical', () => {
    for (const good of ['robotics-2027', 'team-1a2b3c', 'cafe-babe', 'chess-club-2027']) {
      expect(validateHandle(good).ok, good).toBe(true);
    }
  });

  it('refuses a non-string without throwing', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(validateHandle(bad).ok).toBe(false);
    }
  });
});

describe('writing the address', () => {
  it('builds the canonical path', () => {
    expect(handlePath('robotics')).toBe('/organizations/@robotics');
  });

  it('does not double the sigil when given one', () => {
    expect(handlePath('@robotics')).toBe('/organizations/@robotics');
  });

  it('recognises the canonical form, and only that form', () => {
    expect(isHandleForm('@robotics')).toBe(true);
    expect(isHandleForm('robotics')).toBe(false);
    expect(isHandleForm('')).toBe(false);
    expect(isHandleForm(undefined)).toBe(false);
  });
});
