import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { canRunEvent, canManage, canHelpRun } from './organizations.js';

/**
 * Who may run an event, as a contract rather than as a route.
 *
 * ── Why this is a unit test with a throwaway database ──
 *
 * `canRunEvent` is asked at fourteen call sites across four route files, and
 * covering the answer through each of them would be fourteen fixtures asserting
 * the same four facts. The routes' own tests prove they ASK the question; this
 * proves the answer, including the two cases no route test reaches directly:
 * `organization_id: null` being a real answer, and an absent `organization_id`
 * being a caller bug loud enough to find.
 *
 * The handle is built here rather than imported so the table can hold exactly
 * the rows each case needs, and so this file opens no real database.
 */

const NOW = '2026-08-13T00:00:00.000Z';

describe('canRunEvent', () => {
  let db;

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE organization_members (
      organization_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      member_role     TEXT NOT NULL
                        CHECK(member_role IN ('member', 'student_organizer', 'manager')),
      joined_at       TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id))`);

    /* `canRunEvent` re-asks whether the host is still welcome in the club, so
       the bans table is part of the question now — a host who was banned is no
       longer running the club's events. */
    db.exec(`CREATE TABLE organization_bans (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      lifted_at       TEXT)`);
  });

  beforeEach(() => {
    db.exec('DELETE FROM organization_members');
    db.exec('DELETE FROM organization_bans');
    const seat = db.prepare('INSERT INTO organization_members VALUES (?, ?, ?, ?)');
    seat.run('org-1', 'boss', 'manager', NOW);
    seat.run('org-1', 'helper', 'student_organizer', NOW);
    seat.run('org-1', 'member', 'member', NOW);
  });

  /** An event of the club, hosted by the student organizer. */
  const helpersEvent = { organizer_id: 'helper', organization_id: 'org-1' };
  /** An event of the club, hosted by the manager. */
  const bossesEvent = { organizer_id: 'boss', organization_id: 'org-1' };
  /** Somebody's own event, belonging to no club. */
  const personalEvent = { organizer_id: 'stranger', organization_id: null };

  it('lets the host run their own event', async () => {
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(true);
    expect(await canRunEvent(db, personalEvent, 'stranger')).toBe(true);
  });

  it('lets the club’s manager run an event the helper posted', async () => {
    /**
     * The whole reason this function exists. Without it the manager could not
     * edit, cancel, review applicants for or take attendance on an event
     * published under their own club's name — and once the helper was demoted,
     * nobody could, which silently cost every volunteer their hours.
     */
    expect(await canRunEvent(db, helpersEvent, 'boss')).toBe(true);
  });

  it('does NOT let the helper run the manager’s event', async () => {
    /* Being trusted to post the bake-sale shift is not being trusted to call
       off the fundraiser somebody else built. `canManage`, not `canHelpRun`. */
    expect(await canRunEvent(db, bossesEvent, 'helper')).toBe(false);
  });

  it('does not let an ordinary member run anything', async () => {
    expect(await canRunEvent(db, helpersEvent, 'member')).toBe(false);
    expect(await canRunEvent(db, bossesEvent, 'member')).toBe(false);
  });

  it('does not let a manager of ANOTHER club near it', async () => {
    db.prepare('INSERT INTO organization_members VALUES (?, ?, ?, ?)')
      .run('org-2', 'rival', 'manager', NOW);
    expect(await canRunEvent(db, helpersEvent, 'rival')).toBe(false);
  });

  it('lets a moderator past without consulting the club at all', async () => {
    expect(await canRunEvent(db, helpersEvent, 'nobody', { hasModerate: true })).toBe(true);
    /* Including on a row that would otherwise throw — the bypass is answered
       before the event is read, which is what makes it a bypass. */
    expect(await canRunEvent(db, { organizer_id: 'x' }, 'nobody', { hasModerate: true })).toBe(true);
  });

  it('treats a personal event as its host’s alone', async () => {
    /* `organization_id: null` is a real answer, not a missing one: nobody
       manages an event that belongs to no organization. */
    expect(await canRunEvent(db, personalEvent, 'boss')).toBe(false);
    expect(await canRunEvent(db, personalEvent, 'helper')).toBe(false);
  });

  it('THROWS when the row does not carry organization_id at all', async () => {
    /**
     * The distinction the whole guard rests on. Three call sites loaded the
     * event through a query that named its columns and omitted this one; the
     * function read `undefined`, decided the event belonged to no organization,
     * and refused the club's manager. A correct-looking 403 for the wrong
     * reason, invisible to six thousand tests.
     */
    /* `expect(async () => …).rejects`: `canRunEvent` is async now, so its
       refusal is a rejected promise and `expect(fn).toThrow()` would never see
       it — the assertion would pass while the guard did nothing. The async-thunk
       form observes a synchronous throw and a rejection alike. */
    await expect(async () => canRunEvent(db, { organizer_id: 'helper' }, 'boss'))
      .rejects.toThrow(/organization_id/);
  });

  it('is not simply canManage or canHelpRun wearing another name', async () => {
    /* If it collapsed into either, one of the two rows above would be wrong —
       asserted directly so a refactor that "simplifies" it goes red. */
    expect(await canManage(db, 'org-1', 'helper')).toBe(false);
    expect(await canHelpRun(db, 'org-1', 'helper')).toBe(true);
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(true);
    expect(await canRunEvent(db, bossesEvent, 'helper')).toBe(false);
  });

  it('stops the host once the club has removed them', async () => {
    /**
     * Removal used to be incomplete. Somebody removed from a club kept every
     * power over the events they had already posted for it — the roster export
     * with names and emails, the attendance write that credits hours, the
     * broadcast that emails everyone on it. The club had removed their ability
     * to add more, and nothing else.
     */
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(true);
    db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .run('org-1', 'helper');
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(false);
  });

  it('stops the host once the club has BANNED them', async () => {
    db.prepare('INSERT INTO organization_bans VALUES (?, ?, ?, ?)')
      .run('ban-1', 'org-1', 'helper', null);
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(false);
  });

  it('restores them when the ban is lifted', async () => {
    /* Re-asked against the table rather than remembered, so lifting a ban needs
       no second bookkeeping step. */
    db.prepare('INSERT INTO organization_bans VALUES (?, ?, ?, ?)')
      .run('ban-2', 'org-1', 'helper', null);
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(false);
    db.prepare('UPDATE organization_bans SET lifted_at = ? WHERE id = ?').run('2026-08-13', 'ban-2');
    expect(await canRunEvent(db, helpersEvent, 'helper')).toBe(true);
  });

  it('leaves a PERSONAL event alone — there is no club to be removed from', async () => {
    expect(await canRunEvent(db, personalEvent, 'stranger')).toBe(true);
  });

  it('answers false rather than throwing for a missing event or user', async () => {
    expect(await canRunEvent(db, null, 'boss')).toBe(false);
    expect(await canRunEvent(db, helpersEvent, null)).toBe(false);
  });
});
