import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  INVITATION_STATUSES, INVITATION_TTL_MS, SOFT_MAX_PENDING_INVITATIONS, NOTE_MAX,
  invitationState, invitationStands, invitationFor, pendingInvitationFor,
  pendingInvitations, pendingInvitationCount, inviteUser, resolveInvitation,
  acceptInvitationOnJoin, expireLapsedInvitations, invitableUser,
} from './organizationInvitations.js';
import migration062 from './migrations/062_organization_membership_policy.js';
import migration063 from './migrations/063_organization_public_identity.js';

/**
 * The invitation rules, exercised directly against a database.
 *
 * ── Why these are unit tests and not only route tests ──
 *
 * `adminInvitations.test.js` sets the precedent, and the reason is the same: the
 * refusals are the interesting part, and a route test proves one path through
 * each of them. Calling the functions directly is what lets every rejection
 * path be enumerated — including the clock-dependent ones, which a route test
 * can only reach by writing a past date into a column.
 *
 * `db` is a parameter to every one of these functions, which is exactly what
 * makes this file possible without booting a server.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'wev-orginv-'));
let db;

function schema() {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT,
      avatar TEXT, avatar_color TEXT, profile_picture_url TEXT,
      role TEXT NOT NULL DEFAULT 'volunteer', location TEXT,
      account_status TEXT DEFAULT 'active'
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE organization_members (
      organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      member_role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );
  `);
  for (const [id, name, username] of [
    ['u1', 'Leo Chen', 'leochen'],
    ['u2', 'Jordan Whitfield', 'jordanw'],
    ['u3', 'Priya Patel', 'priyap'],
  ]) {
    db.prepare('INSERT INTO users (id, name, username) VALUES (?, ?, ?)').run(id, name, username);
  }
  db.prepare(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at)
    VALUES ('org-1', 'Chess Club', 'chess-club', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at)
    VALUES ('org-2', 'Robotics Club', 'robotics', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  migration062.up(db);
  migration063.up(db);
}

const NOW = new Date('2026-09-04T12:00:00.000Z');
const later = (ms) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `i-${Math.random().toString(36).slice(2)}.db`));
  schema();
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the vocabulary', () => {
  it('names every status the schema accepts, and no others', () => {
    expect(INVITATION_STATUSES).toEqual(['pending', 'accepted', 'declined', 'revoked', 'expired']);
    expect(Object.isFrozen(INVITATION_STATUSES)).toBe(true);
  });

  /**
   * Fourteen days rather than the administrator flow's seven.
   *
   * An administrator invitation is authority awaiting collection and should
   * lapse quickly. A club invitation is an offer, and the person receiving it is
   * a student who may not open the app for a fortnight. It still lapses, because
   * a pending invitation from last year is a decision nobody remembers making.
   */
  it('lets an invitation stand for a fortnight', () => {
    expect(INVITATION_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('bounds the note and the outstanding list', () => {
    expect(NOTE_MAX).toBe(300);
    expect(SOFT_MAX_PENDING_INVITATIONS).toBe(100);
  });
});

describe('reading the state of a row', () => {
  it('reports nothing at all as missing', () => {
    expect(invitationState(null)).toBe('missing');
    expect(invitationState(undefined)).toBe('missing');
    expect(invitationStands(null)).toBe(false);
  });

  it('passes a resolved status straight through', () => {
    for (const status of ['accepted', 'declined', 'revoked', 'expired']) {
      expect(invitationState({ status })).toBe(status);
      expect(invitationStands({ status })).toBe(false);
    }
  });

  it('stands while it is pending and has not lapsed', () => {
    const invitation = { status: 'pending', expiresAt: later(1000).toISOString() };
    expect(invitationState(invitation, NOW)).toBe('pending');
    expect(invitationStands(invitation, NOW)).toBe(true);
  });

  /**
   * Expiry is computed, not swept.
   *
   * An invitation that lapsed at midnight is refused at 00:00:01 without
   * waiting for a worker. That is what stops a lapsed invitation being accepted
   * by a request that arrives before the tidying runs.
   */
  it('lapses on the second it is due, without anything having run', () => {
    const invitation = { status: 'pending', expiresAt: NOW.toISOString() };
    expect(invitationState(invitation, NOW)).toBe('expired');
    expect(invitationStands(invitation, NOW)).toBe(false);
    expect(invitationStands(invitation, later(-1))).toBe(true);
  });

  it('accepts either column spelling, because both shapes reach it', () => {
    /* Rows come back camelCase from the module's own SELECTs and snake_case
       from a raw statement in a test or a migration. */
    expect(invitationState({ status: 'pending', expires_at: NOW.toISOString() }, NOW)).toBe('expired');
  });

  it('stands forever when there is no expiry at all', () => {
    const invitation = { status: 'pending', expiresAt: null };
    expect(invitationStands(invitation, later(100 * 365 * 24 * 60 * 60 * 1000))).toBe(true);
  });
});

describe('inviting somebody', () => {
  it('creates a pending invitation that lapses in a fortnight', async () => {
    const result = await inviteUser(db, 'org-1', 'u1', { invitedBy: 'u2', now: NOW });
    expect(result.ok).toBe(true);
    expect(result.invitation.status).toBe('pending');
    expect(result.invitation.invitedUserId).toBe('u1');
    expect(result.invitation.invitedBy).toBe('u2');
    expect(result.invitation.expiresAt).toBe(later(INVITATION_TTL_MS).toISOString());
  });

  it('stores the note, and no note as null', async () => {
    await inviteUser(db, 'org-1', 'u1', { message: 'come along', now: NOW });
    expect((await invitationFor(db, 'org-1', 'u1')).message).toBe('come along');

    await inviteUser(db, 'org-2', 'u1', { now: NOW });
    expect((await invitationFor(db, 'org-2', 'u1')).message).toBeNull();
  });

  it('refuses a second pending invitation', async () => {
    expect((await inviteUser(db, 'org-1', 'u1', { now: NOW })).ok).toBe(true);
    const again = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    expect(again).toEqual({ ok: false, reason: 'pending' });
  });

  /**
   * The rule that stops the asking.
   *
   * The partial unique index blocks a second PENDING invitation; without this,
   * a member could decline-invite-decline-invite indefinitely, which is
   * harassment with a queue behind it. Deliberately not bypassable by a
   * manager — bypassing is the vector.
   */
  it('refuses after a decline, permanently', async () => {
    const first = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await resolveInvitation(db, 'org-1', first.invitation.id, 'declined', { now: NOW });

    const again = await inviteUser(db, 'org-1', 'u1', { now: later(365 * 24 * 60 * 60 * 1000) });
    expect(again).toEqual({ ok: false, reason: 'declined' });
  });

  /** Withdrawing is the club changing its own mind, so it costs the club nothing. */
  it('allows another after a withdrawal', async () => {
    const first = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await resolveInvitation(db, 'org-1', first.invitation.id, 'revoked', { now: NOW });
    expect((await inviteUser(db, 'org-1', 'u1', { now: NOW })).ok).toBe(true);
  });

  it('allows another after one has lapsed', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    const after = later(INVITATION_TTL_MS + 1000);
    await expireLapsedInvitations(db, 'org-1', { now: after });
    expect((await inviteUser(db, 'org-1', 'u1', { now: after })).ok).toBe(true);
  });

  it('keeps the two clubs separate', async () => {
    expect((await inviteUser(db, 'org-1', 'u1', { now: NOW })).ok).toBe(true);
    /* A pending invitation to one club says nothing about another. */
    expect((await inviteUser(db, 'org-2', 'u1', { now: NOW })).ok).toBe(true);
  });

  it('refuses once the club is at its ceiling', async () => {
    /* A hundred real users, because `invited_user_id` is a foreign key and the
       schema is right to enforce it — an invitation naming nobody would be an
       invitation nobody can accept. Written directly rather than through
       `inviteUser`, because the COUNT is what is under test. */
    for (let i = 0; i < SOFT_MAX_PENDING_INVITATIONS; i += 1) {
      await db.prepare('INSERT INTO users (id, name) VALUES (?, ?)')
        .run(`bulk-user-${i}`, `Bulk Student ${i}`);
      await db.prepare(`
        INSERT INTO organization_invitations
          (id, organization_id, invited_user_id, status, created_at, expires_at)
        VALUES (?, 'org-1', ?, 'pending', ?, ?)
      `).run(`bulk-${i}`, `bulk-user-${i}`, NOW.toISOString(), later(INVITATION_TTL_MS).toISOString());
    }
    expect(await inviteUser(db, 'org-1', 'u1', { now: NOW })).toEqual({ ok: false, reason: 'full' });
  });

  it('never mints a credential', async () => {
    const result = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    /* The id is a handle for management, not a secret: it is only ever usable
       by a manager of this club, on this club's route. */
    expect(result.invitation.id).toMatch(/^oinv-/);
    expect(Object.keys(result.invitation)).not.toContain('token');
  });
});

describe('reading invitations back', () => {
  it('finds the newest row, whatever its status', async () => {
    const first = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await resolveInvitation(db, 'org-1', first.invitation.id, 'revoked', { now: NOW });
    await inviteUser(db, 'org-1', 'u1', { now: later(1000) });

    const found = await invitationFor(db, 'org-1', 'u1');
    expect(found.status).toBe('pending');
  });

  it('answers null for somebody nobody invited', async () => {
    expect(await invitationFor(db, 'org-1', 'u1')).toBeNull();
    expect(await pendingInvitationFor(db, 'org-1', 'u1')).toBeNull();
  });

  it('refuses to report a lapsed invitation as pending', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    expect(await pendingInvitationFor(db, 'org-1', 'u1', { now: NOW })).toBeTruthy();
    expect(await pendingInvitationFor(db, 'org-1', 'u1', {
      now: later(INVITATION_TTL_MS + 1),
    })).toBeNull();
  });

  it('lists the club’s outstanding invitations oldest first, with the person joined in', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW, message: 'first' });
    await inviteUser(db, 'org-1', 'u3', { now: later(1000) });

    const rows = await pendingInvitations(db, 'org-1');
    expect(rows.map(r => r.userId)).toEqual(['u1', 'u3']);
    expect(rows[0].name).toBe('Leo Chen');
    expect(rows[0].username).toBe('leochen');
    expect(rows[0].message).toBe('first');
    /* The invitation's own id is `id`; the person's is `userId`, because
       `profileSummary` writes its own `id` and would otherwise overwrite it. */
    expect(rows[0].id).toMatch(/^oinv-/);
  });

  it('drops an invitation whose recipient is no longer a live account', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await db.prepare(`UPDATE users SET account_status = 'deleted' WHERE id = 'u1'`).run();
    expect(await pendingInvitations(db, 'org-1')).toHaveLength(0);
  });

  it('counts only the pending ones', async () => {
    const first = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await inviteUser(db, 'org-1', 'u3', { now: NOW });
    expect(await pendingInvitationCount(db, 'org-1')).toBe(2);

    await resolveInvitation(db, 'org-1', first.invitation.id, 'declined', { now: NOW });
    expect(await pendingInvitationCount(db, 'org-1')).toBe(1);
  });
});

describe('resolving one', () => {
  /**
   * `WHERE status = 'pending'` is the whole concurrency story.
   *
   * Whichever of accept, decline and revoke lands first changes the row; the
   * others report `already_resolved` rather than overwriting a decision.
   */
  it('resolves once and then reports the decision that stands', async () => {
    const { invitation } = await inviteUser(db, 'org-1', 'u1', { now: NOW });

    expect(await resolveInvitation(db, 'org-1', invitation.id, 'declined', { now: NOW }))
      .toBe('resolved');
    expect(await resolveInvitation(db, 'org-1', invitation.id, 'revoked', { now: NOW }))
      .toBe('already_resolved');

    expect((await invitationFor(db, 'org-1', 'u1')).status).toBe('declined');
  });

  it('answers not_found for an invitation that is not this club’s', async () => {
    const { invitation } = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    /* Scoped by organization AND id, so an id pasted onto another club's route
       resolves nothing. */
    expect(await resolveInvitation(db, 'org-2', invitation.id, 'revoked', { now: NOW }))
      .toBe('not_found');
    expect((await invitationFor(db, 'org-1', 'u1')).status).toBe('pending');
  });

  it('answers not_found for an id that names nothing', async () => {
    expect(await resolveInvitation(db, 'org-1', 'oinv-nope', 'revoked', { now: NOW }))
      .toBe('not_found');
  });

  it('refuses to resolve to pending, or to a status outside the vocabulary', async () => {
    const { invitation } = await inviteUser(db, 'org-1', 'u1', { now: NOW });
    for (const status of ['pending', 'maybe', '', null, undefined]) {
      expect(await resolveInvitation(db, 'org-1', invitation.id, status, { now: NOW }))
        .toBe('not_found');
    }
    expect((await invitationFor(db, 'org-1', 'u1')).status).toBe('pending');
  });

  it('marks it accepted when somebody joins', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await acceptInvitationOnJoin(db, 'org-1', 'u1', { now: NOW });
    expect((await invitationFor(db, 'org-1', 'u1')).status).toBe('accepted');
    expect(await pendingInvitationCount(db, 'org-1')).toBe(0);
  });

  it('is harmless to accept on join when there was no invitation', async () => {
    await expect(acceptInvitationOnJoin(db, 'org-1', 'u1', { now: NOW })).resolves.toBeUndefined();
  });
});

describe('retiring the lapsed ones', () => {
  it('marks them expired and reports how many', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await inviteUser(db, 'org-1', 'u3', { now: NOW });
    const after = later(INVITATION_TTL_MS + 1000);

    expect(await expireLapsedInvitations(db, 'org-1', { now: after })).toBe(2);
    expect(await pendingInvitationCount(db, 'org-1')).toBe(0);
  });

  it('leaves the ones that still stand alone', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    expect(await expireLapsedInvitations(db, 'org-1', { now: NOW })).toBe(0);
    expect(await pendingInvitationCount(db, 'org-1')).toBe(1);
  });

  /**
   * Bookkeeping, not enforcement.
   *
   * `invitationStands` already refuses a lapsed invitation whether or not this
   * has run — which is what makes it safe for this to be lazy, called from the
   * manager's own read rather than from a scheduled job.
   */
  it('is not what makes a lapsed invitation stop working', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    const after = later(INVITATION_TTL_MS + 1000);
    /* Nothing swept, and it already does not stand. */
    expect(await pendingInvitationFor(db, 'org-1', 'u1', { now: after })).toBeNull();
  });

  it('touches only the club it was asked about', async () => {
    await inviteUser(db, 'org-1', 'u1', { now: NOW });
    await inviteUser(db, 'org-2', 'u1', { now: NOW });
    const after = later(INVITATION_TTL_MS + 1000);

    await expireLapsedInvitations(db, 'org-1', { now: after });
    expect((await invitationFor(db, 'org-2', 'u1')).status).toBe('pending');
  });
});

describe('who may be invited', () => {
  it('finds a live account', async () => {
    const row = await invitableUser(db, 'u1');
    expect(row.name).toBe('Leo Chen');
  });

  /**
   * A suspended or deleted account would receive a notification that goes
   * nowhere, leaving a manager holding an invitation that can never be
   * accepted.
   */
  it('refuses an account that is not active', async () => {
    for (const status of ['deleted', 'suspended']) {
      await db.prepare('UPDATE users SET account_status = ? WHERE id = ?').run(status, 'u1');
      expect(await invitableUser(db, 'u1'), status).toBeNull();
    }
  });

  it('refuses an id that names nobody, without throwing', async () => {
    for (const bad of [undefined, null, '', 'nope', 42, {}]) {
      expect(await invitableUser(db, bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('returns exactly what profileSummary reads, and no more', async () => {
    const row = await invitableUser(db, 'u1');
    expect(Object.keys(row).sort()).toEqual([
      'avatar', 'avatar_color', 'id', 'location', 'name',
      'profile_picture_url', 'role', 'username',
    ]);
  });
});
