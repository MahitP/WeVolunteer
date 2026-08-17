/**
 * The persona preview, and every way it must not become a privilege escalation.
 *
 * ── What the feature is ──
 *
 * The platform owner can browse as a plain member of another role, so they can
 * see what a student sees. It is two columns on their own row, resolved
 * server-side on every request.
 *
 * ── What this file is actually guarding ──
 *
 * A role switch is the classic escalation shape, so almost nothing below tests
 * that the feature works. They test that it cannot be turned around: a student
 * whose row says `preview_persona = 'super_admin'` gets nothing, a preview
 * cannot be started by anyone but the owner, a preview cannot be ended on
 * somebody else's behalf, and an expired one has no force.
 *
 * The most important of those is the first, and it deserves saying plainly: the
 * guarantee does NOT come from the routes validating their input. It comes from
 * `can()` intersecting the effective role with `actualRole`, which is re-read
 * from the database on every request. So the escalation cases are asserted
 * against the KERNEL, with the columns written directly — the way a SQL-injection
 * bug, a compromised administrator, or a mistake in this repository would write
 * them. A test that only went through the routes would be testing the validation
 * and calling it a security property.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// db.js opens its connection at module scope, so nothing that reaches it may be
// imported statically here — see the long explanation in testServer.js.
let srv, db, authz, ownerToken;

/**
 * A seeded account promoted to owner by the harness, not the real one.
 *
 * `makeOwner` also enrols it in two-factor, because the policy applies to the
 * role — an owner who is not enrolled is refused by `requireCap` before any of
 * this is reached, which is correct behaviour and a confusing way to discover it.
 */
const OWNER = 'derek.sorensen@example.com';
const STUDENT = 'leo.chen@example.com';

const idFor = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id;

/** Writes preview columns straight onto a row — no route, no validation. */
function forcePreview(email, persona, { expiresInMs = 30 * 60 * 1000 } = {}) {
  db.prepare('UPDATE users SET preview_persona = ?, preview_expires_at = ? WHERE email = ?')
    .run(persona, new Date(Date.now() + expiresInMs).toISOString(), email);
}

function clearPreview(email) {
  db.prepare('UPDATE users SET preview_persona = NULL, preview_expires_at = NULL WHERE email = ?')
    .run(email);
}

/** The principal the application would build for this row, right now. */
async function principalOf(email) {
  const utils = await import('./utils.js');
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  return await utils.buildPrincipal(row);
}

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  authz = await import('./authz.js');

  /* Promote once. `makeOwner` bumps `token_version`, so doing it per test would
     invalidate the sessions the earlier tests are holding. */
  ownerToken = await srv.loginAsOwner(OWNER);
  expect(ownerToken, 'fixture: the owner could not be promoted or signed in').toBeTruthy();
}, 60000);

afterAll(async () => { await srv?.close?.(); });

/* ── The escalation cases, asserted against the kernel ─────────────────────── */

describe('a preview can never add a capability', () => {
  /**
   * The case the whole design exists to make impossible.
   *
   * A student's row is written with `preview_persona = 'super_admin'` — bypassing
   * every route, exactly as a bug or an attacker with a write primitive would.
   * `actualRole` is still read from the database, still says 'student', and the
   * narrowing rule intersects the two.
   */
  it('gives a student nothing when their row claims to be previewing as the owner', async () => {
    forcePreview(STUDENT, 'super_admin');
    try {
      const principal = await principalOf(STUDENT);

      for (const cap of ['admin.create', 'audit.read', 'error.read', 'analytics.platform',
        'user.suspend', 'report.resolve', 'persona.preview']) {
        expect(authz.can(principal, cap), `a forged preview granted ${cap}`).toBe(false);
      }
    } finally { clearPreview(STUDENT); }
  });

  /** And the same for every role a forged preview could name. */
  it.each(['super_admin', 'admin', 'organizer', 'partner'])(
    'gives a student nothing when their row claims the %s persona', async (persona) => {
      forcePreview(STUDENT, persona);
      try {
        const principal = await principalOf(STUDENT);
        const student = { effectiveRole: 'student', actualRole: null, grants: [], withheld: [] };

        for (const cap of authz.ALL_CAPABILITIES) {
          if (authz.can(principal, cap)) {
            expect(authz.can(student, cap), `${persona} preview added ${cap} to a student`).toBe(true);
          }
        }
      } finally { clearPreview(STUDENT); }
    });

  /**
   * A preview is never a way to keep something. Whatever the previewing owner
   * can do must be a subset of what a plain member of that persona can do — the
   * point of the feature, and the half that a narrowing-only rule does not give
   * you for free.
   */
  it('holds nothing beyond what a plain member of the persona holds', async () => {
    forcePreview(OWNER, 'student');
    try {
      const principal = await principalOf(OWNER);
      const student = { effectiveRole: 'student', actualRole: null, grants: [], withheld: [] };

      for (const cap of authz.ALL_CAPABILITIES) {
        if (authz.can(principal, cap)) {
          expect(authz.can(student, cap), `previewing owner kept ${cap}, which no student holds`)
            .toBe(true);
        }
      }
      /* And it genuinely lost the owner's reach, rather than trivially holding
         nothing at all. */
      expect(authz.can(principal, 'audit.read')).toBe(false);
      expect(authz.can(principal, 'admin.create')).toBe(false);
      expect(authz.can(principal, 'event.apply')).toBe(true);
    } finally { clearPreview(OWNER); }
  });

  /**
   * Per-user grants do not survive into a preview.
   *
   * A grant extends what THIS account may do. A preview asks what a plain member
   * of a role sees, so answering it with this account's extras would show the
   * owner a student's view containing something no student has — which quietly
   * defeats the only job the feature has.
   */
  it('ignores per-user grants while previewing', async () => {
    const principal = {
      actualRole: 'admin', effectiveRole: 'student',
      grants: ['organizer.approve'], withheld: []
    };
    expect(authz.can(principal, 'organizer.approve')).toBe(false);

    /* The same grant is honoured when no preview is in force, so the assertion
       above is about the preview and not about grants being broken. */
    expect(authz.can({ ...principal, effectiveRole: 'admin' }, 'organizer.approve')).toBe(true);
  });
});

/* ── Resolution: when a preview counts ────────────────────────────────────── */

describe('when a preview is in force', () => {
  it('is ignored once expired', async () => {
    forcePreview(OWNER, 'student', { expiresInMs: -1000 });
    try {
      const principal = await principalOf(OWNER);
      expect(authz.can(principal, 'audit.read'), 'an expired preview still narrowed').toBe(true);
      expect(authz.previewPersonaOf(principal)).toBe(null);
    } finally { clearPreview(OWNER); }
  });

  /**
   * Half a preview is no preview. A row with one column written and not the other
   * resolves to the real role — the safe direction for a field whose only power
   * is to take capabilities away.
   */
  it('is ignored when only one of the two columns is set', async () => {
    await db.prepare("UPDATE users SET preview_persona = 'student', preview_expires_at = NULL WHERE email = ?")
      .run(OWNER);
    try {
      expect(authz.can(await principalOf(OWNER), 'audit.read')).toBe(true);
    } finally { clearPreview(OWNER); }

    await db.prepare("UPDATE users SET preview_persona = NULL, preview_expires_at = ? WHERE email = ?")
      .run(new Date(Date.now() + 60000).toISOString(), OWNER);
    try {
      expect(authz.can(await principalOf(OWNER), 'audit.read')).toBe(true);
    } finally { clearPreview(OWNER); }
  });

  /**
   * A persona that is not a role resolves to no preview, rather than to a role
   * that matches nothing.
   *
   * The difference matters: `can()` denies everything for an unknown role, so a
   * junk value treated as a persona would lock the account out of the whole
   * application until the expiry — from one bad write, with no way back in,
   * because even the exit route needs a capability.
   */
  it.each(['', 'root', 'SUPER_ADMIN', 'admin ', '*', 'undefined'])(
    'treats %s as no preview at all', async (junk) => {
      forcePreview(OWNER, junk);
      try {
        const principal = await principalOf(OWNER);
        expect(authz.can(principal, 'audit.read'), `'${junk}' was honoured as a persona`).toBe(true);
        expect(authz.can(principal, 'persona.preview.exit')).toBe(true);
      } finally { clearPreview(OWNER); }
    });

  /** Previewing as your own role is not a preview, and does not report as one. */
  it('reports nothing when the persona equals the real role', async () => {
    forcePreview(STUDENT, 'student');
    try {
      expect(authz.previewPersonaOf(await principalOf(STUDENT))).toBe(null);
    } finally { clearPreview(STUDENT); }
  });
});

/* ── The way out is always available ──────────────────────────────────────── */

describe('a preview cannot trap the account that started it', () => {
  /**
   * The exit capability is held by every role — otherwise an owner previewing as
   * a student would lose the ability to stop, until the expiry, by using the
   * feature exactly as intended.
   */
  it.each(['student', 'organizer', 'admin', 'partner', 'super_admin'])(
    '%s holds persona.preview.exit', (role) => {
      expect(authz.can({ effectiveRole: role, actualRole: null, grants: [], withheld: [] },
        'persona.preview.exit')).toBe(true);
    });

  it('leaves the exit reachable from inside every previewable persona', async () => {
    for (const persona of ['student', 'organizer', 'admin', 'partner']) {
      forcePreview(OWNER, persona);
      try {
        expect(authz.can(await principalOf(OWNER), 'persona.preview.exit'),
          `an owner previewing as ${persona} could not leave`).toBe(true);
      } finally { clearPreview(OWNER); }
    }
  });

  /**
   * And it survives an organizer's withheld set.
   *
   * `withheld` is an absolute deny checked before everything, so a capability
   * that landed on that list would be unreachable even to `can()`'s wildcard —
   * and an owner previewing as an unaccepted organizer would be stuck.
   */
  it('is not withholdable by the organizer agreement', async () => {
    const { ORGANIZER_GATED_CAPABILITIES } = await import('./organizerAgreement.js');
    expect(ORGANIZER_GATED_CAPABILITIES).not.toContain('persona.preview.exit');
  });
});

/* ── Who may start one ────────────────────────────────────────────────────── */

describe('starting a preview is owner-only and ungrantable', () => {
  it('is refused to every role but the owner', () => {
    for (const role of ['student', 'organizer', 'admin', 'partner']) {
      expect(authz.can({ effectiveRole: role, actualRole: null, grants: [], withheld: [] },
        'persona.preview'), `${role} could start a preview`).toBe(false);
    }
  });

  /**
   * SUPER_ONLY, so no per-user grant reaches it. "Let the helpdesk see what a
   * student sees" is an extremely reasonable-sounding grant that would put a role
   * switch in the hands of an account nobody audited for one.
   */
  it('cannot be reached by a per-user grant', () => {
    expect(authz.SUPER_ONLY).toContain('persona.preview');
    expect(authz.can(
      { effectiveRole: 'admin', actualRole: null, grants: ['persona.preview'], withheld: [] },
      'persona.preview'
    )).toBe(false);
  });
});

/* ── Over HTTP ────────────────────────────────────────────────────────────── */

describe('the persona preview endpoints', () => {
  const start = (persona, token) =>
    srv.call('POST', '/api/admin/persona-preview', { persona }, token);
  const stop = (token) => srv.call('DELETE', '/api/admin/persona-preview', undefined, token);

  it('refuses an anonymous caller', async () => {
    expect((await start('student', undefined)).status).toBe(401);
  });

  it('refuses a student', async () => {
    const token = await srv.login(STUDENT);
    const res = await start('student', token);
    expect(res.status).toBe(403);
    expect((await db.prepare('SELECT preview_persona FROM users WHERE email = ?').get(STUDENT))
      .preview_persona).toBeNull();
  });

  it('lets the owner start one, and narrows the very next request', async () => {
    try {
      const res = await start('student', ownerToken);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.persona).toBe('student');

      /* The proof that it is server-side: the narrowing is visible on the very
         next request, without the client having been asked anything. */
      const me = await srv.call('GET', '/api/auth/me', undefined, ownerToken);
      expect(me.body.preview).toEqual({ persona: 'student', expiresAt: expect.any(String) });
      expect(me.body.role, 'the real role stopped being reported').toBe('super_admin');
    } finally { clearPreview(OWNER); }
  });

  it('refuses a persona that is not a role', async () => {
    for (const junk of ['root', 'super_admin', '', null, 42]) {
      const res = await start(junk, ownerToken);
      expect(res.status, `'${junk}' was accepted as a persona`).toBe(400);
    }
    expect((await db.prepare('SELECT preview_persona FROM users WHERE email = ?').get(OWNER))
      .preview_persona).toBeNull();
  });

  /**
   * Ending a preview clears the CALLER'S row and takes no parameter naming whose.
   *
   * Every role holds the exit capability, so a parameter here would make this an
   * endpoint every student could aim at the owner.
   */
  it('ends only the caller\'s own preview', async () => {
    forcePreview(OWNER, 'student');
    const studentToken = await srv.login(STUDENT);

    try {
      const res = await stop(studentToken);
      expect(res.status).toBe(200);

      expect(
        (await db.prepare('SELECT preview_persona FROM users WHERE email = ?').get(OWNER)).preview_persona,
        "a student's exit call cleared the owner's preview"
      ).toBe('student');
    } finally { clearPreview(OWNER); }
  });

  it('is a no-op for an account with no preview', async () => {
    const token = await srv.login(STUDENT);
    expect((await stop(token)).status).toBe(200);
  });
});
