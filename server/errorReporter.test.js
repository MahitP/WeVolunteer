/**
 * The error reporter, driven against a throwaway in-memory database.
 *
 * `errorReporter.js` imports `node:crypto` and `clientRoutes.js` (plain data),
 * so a static import here reaches nothing — which is what lets this file build
 * the schema itself instead of booting a server. The schema below is copied from
 * migration 004 deliberately: if the two drift, these tests fail, which is the
 * correct outcome for a module that writes those exact columns.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  recordError, fingerprint, normaliseClientRoute, redactMessage, redactStack,
  CLIENT_GROUP_CEILING, MAX_EVENTS_PER_GROUP, OVERFLOW_FINGERPRINT, REDACTED
} from './errorReporter.js';

let db;

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  const { default: migration } = await import('./migrations/004_error_events.js');
  migration.up(db);
});

const groups = () => db.prepare('SELECT * FROM error_groups').all();
const events = () => db.prepare('SELECT * FROM error_events').all();
const base = (over = {}) => ({ source: 'server', kind: 'TypeError', message: 'boom', ...over });

/** A distinct word per index — survives the fingerprint's digit collapsing. */
const label = (n) => {
  let out = '', x = n;
  do { out += String.fromCharCode(97 + (x % 26)); x = Math.floor(x / 26); } while (x > 0);
  return out;
};

/* ── Redaction ─────────────────────────────────────────────────────────── */

describe('redactMessage — one rule, one realistic positive', () => {
  it('removes an email address', () => {
    const out = redactMessage('Failed to mail leo.chen28@gmail.com about their shift');
    expect(out).not.toContain('leo.chen28@gmail.com');
    expect(out).toContain(REDACTED);
  });

  /**
   * An accented name must not survive INSIDE the match.
   *
   * The rule was `[A-Za-z0-9._%+-]+@…` and therefore stopped at the first
   * non-ASCII character, so it did not fail cleanly — it matched from the
   * ASCII run that reached the `@` and stored `josé.garcí[redacted]`, which is
   * the student's given name and most of their surname, on a row that looks
   * redacted. `notificationWorker.js` records the message of a failed send
   * verbatim, so one bounce is the whole path.
   *
   * Asserted on the FRAGMENTS rather than on the whole address: the full string
   * was already absent before the fix, and a test that only checked for it
   * passed while the leak was in the table.
   */
  it.each([
    ['precomposed accents', 'SMTP bounce for josé.garcía@lincolnhigh.k12.il.us', ['josé', 'garcí']],
    // NFD: the accents are separate combining marks, which is why `\p{M}` is in
    // the character class — without it the match would end at the mark and
    // reproduce the same partial leak in a different normalisation form.
    ['decomposed accents', 'SMTP bounce for josé.garcía@lincolnhigh.org'.normalize('NFD'),
      ['josé'.normalize('NFD'), 'garcí'.normalize('NFD')]],
    ['non-latin script', 'SMTP bounce for 田中@例え.jp', ['田中']],
    ['accented domain', 'SMTP bounce for admin@schüle.de', ['schüle']],
  ])('removes an email address written with %s', (_label, input, fragments) => {
    const out = redactMessage(input);
    for (const fragment of fragments) expect(out).not.toContain(fragment);
    expect(out).toContain(REDACTED);
  });

  /**
   * A certificate code is a bearer credential, not an identifier:
   * `GET /api/certificates/verify/:code` is unauthenticated and answers with a
   * student's name, their event and their hours. The route normaliser has
   * always refused to store one; a code arriving inside a message did not go
   * through that path and reached the table.
   */
  it('removes a certificate code', () => {
    const out = redactMessage('Certificate WEV-4K7P-9X2M could not be rendered');
    expect(out).not.toContain('WEV-4K7P-9X2M');
    expect(out).toContain(REDACTED);
  });

  /**
   * The cost side of the same rule. `testServer.js` names its scratch
   * directories `wev-test-XXXXXX`, and those appear in stack traces — a
   * case-insensitive code rule would eat them and make traces unreadable.
   */
  it.each([
    ['a lowercase scratch path', 'at boot (/var/folders/wev-test-abcd/x.js:1:1)'],
    ['the excluded alphabet', 'code WEV-I0O1-I0O1 is not one of ours'],
  ])('leaves %s alone', (_label, input) => {
    expect(redactMessage(input)).toBe(input);
  });

  it('removes a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InUtMSJ9.abc123def456';
    expect(redactMessage(`token ${jwt} rejected`)).not.toContain('eyJhbGci');
  });

  it('removes a bearer token', () => {
    expect(redactMessage('Authorization: Bearer sk_live_abcdef123456')).not.toContain('sk_live_abcdef123456');
  });

  it('removes a step-up challenge id', () => {
    expect(redactMessage('reauth-1f0c9a2b-77de-4a11-8f3c-0d9e2b6a4c55 expired'))
      .not.toContain('1f0c9a2b-77de');
  });

  /**
   * Every way a person actually writes a phone number.
   *
   * The digit-run rule already named "a phone number" among the things it
   * caught, and caught only the unformatted form. The v1.2c release review
   * probed the rules with realistic PII shapes rather than reading them, and
   * every separated form went through untouched — in an application whose users
   * are mostly minors.
   */
  it.each([
    ['dashed', 'sms to 555-123-4567 failed'],
    ['dotted', 'sms to 555.123.4567 failed'],
    ['spaced', 'sms to 555 123 4567 failed'],
    ['parenthesised with country code', 'sms to +1 (555) 123-4567 failed'],
    ['parenthesised', 'sms to (555) 123-4567 failed'],
    ['unformatted', 'sms to 5551234567 failed'],
  ])('removes a %s phone number', (_label, input) => {
    const out = redactMessage(input);
    expect(out).not.toMatch(/\d{3}[\s.-]?\d{4}/);
    expect(out).toContain(REDACTED);
  });

  /**
   * The other half, and the reason the pattern is narrow rather than greedy: a
   * message in which every number has been redacted cannot be debugged from, so
   * over-redaction is a real cost rather than a safe default.
   */
  it.each([
    ['an ISO date', 'deployed 2026-08-04'],
    ['a semver', 'bundle v1.2.3 failed'],
    ['a stack position', 'at Foo (/assets/x.js:123:456)'],
    ['an ISO timestamp', 'occurred 2026-08-04T00:25:42.649Z'],
    ['a coordinate pair', 'near 40.7128 -74.0060'],
  ])('leaves %s alone', (_label, input) => {
    expect(redactMessage(input)).toBe(input);
  });

  it('removes a long hex run and a long digit run', () => {
    expect(redactMessage(`cert ${'a1b2c3d4'.repeat(4)} missing`)).toContain(REDACTED);
    expect(redactMessage('phone 5551234567 unreachable')).not.toContain('5551234567');
  });

  it('truncates AFTER redacting, so a secret near the end cannot survive the cut', () => {
    const out = redactMessage(`${'x'.repeat(600)} student@example.org`);
    expect(out).not.toContain('student@example.org');
  });

  it('returns a string for any input', () => {
    for (const bad of [null, undefined, 42, {}, []]) expect(redactMessage(bad)).toBe('');
  });

  /**
   * Redaction must stay linear in the input, because the input is
   * attacker-sized: `POST /api/errors/report` is unauthenticated.
   *
   * The email rule is `[A-Za-z0-9._%+-]+@…`. Against a long run of matching
   * characters containing no `@`, the engine retries from every start position —
   * quadratic. Measured before the input bound existed: **~13 seconds for one
   * 100 kB message**, which is one request burning the event loop, the reporter
   * becoming the outage it exists to detect.
   *
   * Asserted with a deliberately enormous margin. Bounded this is ~1 ms and
   * unbounded it is ~13 000 ms, so a one-second threshold is three orders of
   * magnitude from either side and is not a timing race. Without this the
   * property is enforced only by vitest's default timeout, which is an accident
   * rather than a test — it would silently stop protecting anything if the
   * timeout were raised.
   */
  it('stays linear on a hostile-sized message rather than backtracking', () => {
    const hostile = 'y'.repeat(100_000);
    const started = performance.now();
    const out = redactMessage(hostile);
    const elapsed = performance.now() - started;

    expect(out.length).toBeLessThanOrEqual(501);
    expect(
      elapsed,
      `redacting 100 kB took ${Math.round(elapsed)}ms — the input bound is gone and the regexes are backtracking`
    ).toBeLessThan(1000);
  });

  it('stays linear on a hostile-sized stack too', () => {
    const hostile = `Error\n${'    at frame (server/a.js:1:1)\n'.repeat(3000)}`;
    const started = performance.now();
    redactStack(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('redactStack', () => {
  it('strips machine-specific absolute prefixes that can name a person', () => {
    const out = redactStack('Error\n    at foo (/home/alice/wev/server/app.js:12:5)');
    expect(out).not.toContain('/home/alice');
    expect(out).toContain('server/app.js');
  });

  it('keeps the first node_modules frame and drops the rest', () => {
    const out = redactStack([
      'Error', '    at a (server/app.js:1:1)',
      '    at b (node_modules/express/lib/router.js:1:1)',
      '    at c (node_modules/express/lib/layer.js:1:1)',
      '    at d (node_modules/express/lib/route.js:1:1)',
    ].join('\n'));
    expect(out.match(/node_modules/g)?.length).toBe(1);
  });

  it('redacts inside the stack too, and returns null for a non-string', () => {
    expect(redactStack('at send (a@b.com)')).not.toContain('a@b.com');
    expect(redactStack(undefined)).toBeNull();
  });
});

/* ── Route normalisation: the PII decision ─────────────────────────────── */

describe('normaliseClientRoute — hostile input, not tidy input', () => {
  it('drops a query string carrying a street address', () => {
    expect(normaliseClientRoute('/events?q=12%20Maple%20Ave')).toBe('/events');
  });

  it('drops a fragment', () => {
    expect(normaliseClientRoute('/events#section-3')).toBe('/events');
    expect(normaliseClientRoute('/events#/a?b=c')).toBe('/events');
  });

  it('stores the PATTERN, never the value that occupied a param', () => {
    expect(normaliseClientRoute('/checkin/event-softball-2026')).toBe('/checkin/:eventId');
    expect(normaliseClientRoute('/events/evt-abc-123/edit')).toBe('/events/:id/edit');
  });

  it('never stores a certificate code, even though the route is allowed', () => {
    const out = normaliseClientRoute('/verify/CERT-7Q2X9F');
    expect(out).toBe('/verify/:code');
    expect(out).not.toContain('7Q2X9F');
  });

  it('never lets a reset token survive', () => {
    const out = normaliseClientRoute('/reset-password?token=eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig');
    expect(out).toBe('/reset-password');
    expect(out).not.toContain('eyJ');
  });

  it('prefers the more literal pattern when two could match', () => {
    expect(normaliseClientRoute('/events/new')).toBe('/events/new');
  });

  it('answers unknown for traversal, protocol-relative and absurd input', () => {
    for (const hostile of [
      '/../../etc/passwd', '/events/../../secret', '//evil.com/x',
      'https://evil.com/events', 'events', '', '/' + 'a'.repeat(5000),
      '/a\\b', '/events\0',
    ]) {
      expect(normaliseClientRoute(hostile), `${hostile} was not rejected`).toBe('unknown');
    }
  });

  it('answers unknown for non-strings without throwing', () => {
    for (const bad of [null, undefined, 42, {}, [], true, Symbol('x')]) {
      expect(() => normaliseClientRoute(bad)).not.toThrow();
      expect(normaliseClientRoute(bad)).toBe('unknown');
    }
  });

  it('answers unknown for a real-looking path that is not a declared route', () => {
    expect(normaliseClientRoute('/admin/secret-panel')).toBe('unknown');
    expect(normaliseClientRoute('/users/user-student-2/profile')).toBe('unknown');
  });

  it('matches the root route', () => {
    expect(normaliseClientRoute('/')).toBe('/');
    expect(normaliseClientRoute('/?ref=email')).toBe('/');
  });
});

/* ── Fingerprinting ────────────────────────────────────────────────────── */

describe('fingerprint', () => {
  it('collapses occurrences that differ only by an id or a number', () => {
    const a = fingerprint({ source: 'server', kind: 'TypeError', message: "Cannot read 'x' of undefined at row 41", route: '/api/e' });
    const b = fingerprint({ source: 'server', kind: 'TypeError', message: "Cannot read 'x' of undefined at row 9", route: '/api/e' });
    expect(a).toBe(b);
  });

  it('separates genuinely different problems', () => {
    const a = fingerprint({ source: 'server', kind: 'TypeError', message: 'a is not a function', route: '/x' });
    const b = fingerprint({ source: 'server', kind: 'RangeError', message: 'a is not a function', route: '/x' });
    const c = fingerprint({ source: 'client', kind: 'TypeError', message: 'a is not a function', route: '/x' });
    const d = fingerprint({ source: 'server', kind: 'TypeError', message: 'a is not a function', route: '/y' });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('is a hex digest and is stable across calls', () => {
    const args = { source: 'client', kind: 'Error', message: 'x', route: '/events' };
    expect(fingerprint(args)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(args)).toBe(fingerprint(args));
  });

  /**
   * The fingerprint is computed after redaction, so a message that contained an
   * address cannot be recovered from — or identified by — the stored digest.
   */
  it('is computed from the redacted message, not the raw one', () => {
    const raw = 'mail to leo.chen28@gmail.com failed';
    const viaRecord = fingerprint({ source: 'server', kind: 'TypeError', message: redactMessage(raw), route: null });
    const viaRaw = fingerprint({ source: 'server', kind: 'TypeError', message: raw, route: null });
    expect(viaRecord).not.toBe(viaRaw);

    recordError(db, base({ message: raw }));
    const [g] = groups();
    expect(g.message).not.toContain('leo.chen28@gmail.com');
    expect(g.fingerprint).toBe(viaRecord);
  });
});

/* ── Recording ─────────────────────────────────────────────────────────── */

describe('recordError — the happy path', () => {
  it('creates one group and one event', () => {
    const res = recordError(db, base({ route: '/api/events/:id', method: 'GET', statusCode: 500 }));
    expect(res.ok).toBe(true);
    expect(groups().length).toBe(1);
    expect(events().length).toBe(1);
    expect(groups()[0]).toMatchObject({ source: 'server', kind: 'TypeError', occurrences: 1, status: 'open' });
  });

  it('increments the counter instead of duplicating the group', () => {
    for (let i = 0; i < 5; i++) recordError(db, base());
    expect(groups().length).toBe(1);
    expect(groups()[0].occurrences).toBe(5);
  });

  it('reopens a resolved group when the problem recurs', () => {
    recordError(db, base());
    db.prepare("UPDATE error_groups SET status = 'resolved', resolved_at = 'x'").run();
    recordError(db, base());
    expect(groups()[0].status).toBe('open');
    expect(groups()[0].resolved_at).toBeNull();
  });

  it('drops every context key the table cannot hold', () => {
    recordError(db, base({
      context: {
        component: 'EventModal', eventId: 'evt-1',
        password: 'hunter2', newEmail: 'a@b.com', challengeId: 'reauth-abc', token: 'x'
      }
    }));
    const ctx = events()[0].context;
    expect(ctx).toContain('EventModal');
    for (const leak of ['hunter2', 'a@b.com', 'reauth-abc', 'password', 'newEmail', 'challengeId', 'token']) {
      expect(ctx, `${leak} survived the context allowlist`).not.toContain(leak);
    }
  });

  it('stores the normalised route for a client report, not what was sent', () => {
    recordError(db, base({ source: 'client', route: '/verify/CERT-SECRET-9?token=abc#frag' }));
    expect(groups()[0].route).toBe('/verify/:code');
    expect(events()[0].route).toBe('/verify/:code');
  });

  it('never stores a raw client path anywhere in either table', () => {
    recordError(db, base({ source: 'client', route: '/admin/secret-panel?user=leo@x.com' }));
    const dump = JSON.stringify([...groups(), ...events()]);
    expect(dump).not.toContain('secret-panel');
    expect(dump).not.toContain('leo@x.com');
    expect(groups()[0].route).toBe('unknown');
  });
});

describe('recordError — never throws', () => {
  it('survives a db whose prepare throws', () => {
    const hostile = { prepare: () => { throw new Error('database is locked'); } };
    let res;
    expect(() => { res = recordError(hostile, base()); }).not.toThrow();
    expect(res.ok).toBe(false);
  });

  it('survives a db whose run throws mid-write', () => {
    const hostile = { prepare: () => ({ get: () => undefined, run: () => { throw new Error('disk I/O'); } }) };
    expect(() => recordError(hostile, base())).not.toThrow();
  });

  it('survives no db, no event, and hostile payloads', () => {
    for (const call of [
      () => recordError(null, base()),
      () => recordError(undefined, undefined),
      () => recordError(db, null),
      () => recordError(db, 'nope'),
      () => recordError(db, base({ message: { toString() { throw new Error('hostile toString'); } } })),
      () => recordError(db, base({ stack: 12345, context: 'not-an-object' })),
      () => recordError(db, base({ kind: 'x'.repeat(10_000), message: 'y'.repeat(100_000) })),
    ]) {
      expect(call).not.toThrow();
    }
  });

  it('refuses an unknown source rather than guessing one', () => {
    expect(recordError(db, base({ source: 'browser' })).ok).toBe(false);
    expect(recordError(db, base({ source: undefined })).ok).toBe(false);
    expect(groups().length).toBe(0);
  });
});

describe('recordError — storage is bounded', () => {
  it('keeps at most 50 events for one fingerprint while the counter keeps climbing', () => {
    for (let i = 0; i < 120; i++) recordError(db, base());
    expect(groups()[0].occurrences).toBe(120);
    expect(events().length).toBeLessThanOrEqual(MAX_EVENTS_PER_GROUP);
  });

  /**
   * The unauthenticated-intake bound. Without it the fingerprint is
   * attacker-chosen and every forged one earns its own group.
   */
  it('stops creating client groups at the ceiling and counts the overflow', () => {
    for (let i = 0; i < CLIENT_GROUP_CEILING + 25; i++) {
      // Distinct by LETTERS, not digits: the fingerprint deliberately collapses
      // numeric variation, so `failure 1` and `failure 2` are one group. An
      // attacker varies words, and so must this test.
      const res = recordError(db, base({ source: 'client', message: `unique failure ${label(i)}` }));
      expect(res.ok, 'overflow must still read as accepted — a different answer is an oracle').toBe(true);
    }

    const clientGroups = db.prepare(
      "SELECT COUNT(*) c FROM error_groups WHERE source = 'client' AND fingerprint != ?"
    ).get(OVERFLOW_FINGERPRINT).c;
    expect(clientGroups).toBeLessThanOrEqual(CLIENT_GROUP_CEILING);

    const overflow = db.prepare('SELECT * FROM error_groups WHERE fingerprint = ?').get(OVERFLOW_FINGERPRINT);
    expect(overflow, 'the flood vanished silently instead of being counted').toBeTruthy();
    expect(overflow.occurrences).toBeGreaterThan(0);
  });

  it('does not apply the client ceiling to server errors', () => {
    for (let i = 0; i < 20; i++) recordError(db, base({ message: `server problem ${label(i)}` }));
    expect(groups().filter(g => g.source === 'server').length).toBeGreaterThan(10);
  });
});

describe('errorReporter imports nothing that could reach db.js', () => {
  it('imports only node:crypto and clientRoutes.js', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, 'errorReporter.js'), 'utf8');
    const specs = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1]);
    expect(specs.sort()).toEqual(['./clientRoutes.js', 'crypto']);
  });
});
