/**
 * Retention. The task that had to land before anything accepts a report.
 *
 * Every assertion here is about DELETION, which is the one operation in this
 * release that cannot be undone — so the tests check both sides of every
 * boundary rather than only the side that deletes. A retention rule that is too
 * eager destroys evidence somebody needed; one that is too lax is the unbounded
 * table the whole design exists to prevent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  sweepErrors, recordError, OVERFLOW_FINGERPRINT,
  EVENT_RETENTION_DAYS, CLOSED_GROUP_RETENTION_DAYS,
  OPEN_GROUP_RETENTION_DAYS, SINGLE_CLIENT_GROUP_RETENTION_DAYS
} from './errorReporter.js';

let db;
const NOW = new Date('2026-08-03T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  const { default: migration } = await import('./migrations/004_error_events.js');
  migration.up(db);
});

/** A group written directly, so its age and status are exactly what a case needs. */
function group(fingerprint, over = {}) {
  const o = {
    source: 'server', kind: 'TypeError', message: 'm', route: null,
    status: 'open', occurrences: 5, lastSeen: daysAgo(1), ...over
  };
  db.prepare(`
    INSERT INTO error_groups
      (fingerprint, source, kind, message, route, status, occurrences, users_seen, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(fingerprint, o.source, o.kind, o.message, o.route, o.status, o.occurrences, o.lastSeen, o.lastSeen);
  return fingerprint;
}

function event(id, fingerprint, occurredAt) {
  db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
    .run(id, fingerprint, occurredAt);
}

const groupIds = () => db.prepare('SELECT fingerprint FROM error_groups ORDER BY fingerprint').all().map(r => r.fingerprint);
const eventIds = () => db.prepare('SELECT id FROM error_events ORDER BY id').all().map(r => r.id);

describe('sweepErrors — safe on nothing at all', () => {
  it('does not throw or delete on an empty database', async () => {
    let res;
    res = await sweepErrors(db, NOW);
    expect(res).toEqual({ groups: 0, events: 0 });
  });

  it('never throws on a hostile or missing db', async () => {
    for (const bad of [null, undefined, {}, { prepare: () => { throw new Error('locked'); } }]) {
      let res;
      res = await sweepErrors(bad, NOW);
      expect(res.failed).toBe(true);
      expect(res).toMatchObject({ groups: 0, events: 0 });
    }
  });

  it('handles a group that has no events at all', async () => {
    group('fp-eventless', { lastSeen: daysAgo(2) });
    await expect(sweepErrors(db, NOW)).resolves.not.toThrow();
    // Groups are the source of truth: having no evidence is not a reason to die.
    expect(groupIds()).toContain('fp-eventless');
  });
});

describe('sweepErrors — each rule, at both sides of its boundary', () => {
  it('deletes events past the retention window and keeps the rest', async () => {
    const fp = group('fp-events');
    event('ev-old', fp, daysAgo(EVENT_RETENTION_DAYS + 1));
    event('ev-edge', fp, daysAgo(EVENT_RETENTION_DAYS - 1));
    event('ev-new', fp, daysAgo(1));

    const res = await sweepErrors(db, NOW);

    expect(eventIds()).toEqual(['ev-edge', 'ev-new']);
    expect(res.events).toBe(1);
    // The counter outlives the evidence — the reason there are two tables.
    expect(db.prepare('SELECT occurrences FROM error_groups WHERE fingerprint = ?').get(fp).occurrences).toBe(5);
  });

  it('deletes resolved and ignored groups past their window, with their events', async () => {
    group('fp-resolved-old', { status: 'resolved', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS + 1) });
    group('fp-ignored-old', { status: 'ignored', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS + 1) });
    group('fp-resolved-recent', { status: 'resolved', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS - 1) });
    event('ev-doomed', 'fp-resolved-old', daysAgo(1)); // young: only cascade can remove it

    await sweepErrors(db, NOW);

    expect(groupIds()).toEqual(['fp-resolved-recent']);
    expect(eventIds(), 'cascade did not take the events of a deleted group').toEqual([]);
  });

  it('keeps an open group until its much longer window closes', async () => {
    group('fp-open-old', { lastSeen: daysAgo(OPEN_GROUP_RETENTION_DAYS + 1) });
    group('fp-open-mid', { lastSeen: daysAgo(OPEN_GROUP_RETENTION_DAYS - 1) });
    // Well past the CLOSED window, and still kept: an unresolved problem is
    // still true, which is exactly why the two windows differ.
    group('fp-open-90d', { lastSeen: daysAgo(90) });

    await sweepErrors(db, NOW);

    expect(groupIds()).toEqual(['fp-open-90d', 'fp-open-mid']);
  });

  it('drains single-occurrence CLIENT groups after a week', async () => {
    group('fp-flood', { source: 'client', occurrences: 1, lastSeen: daysAgo(SINGLE_CLIENT_GROUP_RETENTION_DAYS + 1) });
    group('fp-flood-fresh', { source: 'client', occurrences: 1, lastSeen: daysAgo(SINGLE_CLIENT_GROUP_RETENTION_DAYS - 1) });
    // A real client bug recurs, and is therefore kept on the open-group window.
    group('fp-real-client', { source: 'client', occurrences: 2, lastSeen: daysAgo(60) });
    // Server groups are not attacker-creatable and are not subject to this rule.
    group('fp-server-single', { source: 'server', occurrences: 1, lastSeen: daysAgo(60) });

    await sweepErrors(db, NOW);

    expect(groupIds()).toEqual(['fp-flood-fresh', 'fp-real-client', 'fp-server-single']);
  });

  it('reports what it removed', async () => {
    group('fp-a', { status: 'resolved', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS + 1) });
    group('fp-b', { source: 'client', occurrences: 1, lastSeen: daysAgo(SINGLE_CLIENT_GROUP_RETENTION_DAYS + 1) });
    const alive = group('fp-c');
    event('ev-old', alive, daysAgo(EVENT_RETENTION_DAYS + 1));

    expect(await sweepErrors(db, NOW)).toEqual({ groups: 2, events: 1 });
  });
});

describe('sweepErrors — the invariants it must not break', () => {
  it('leaves no orphaned event behind, by any path', async () => {
    const doomed = group('fp-doomed', { status: 'resolved', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS + 1) });
    const alive = group('fp-alive');
    for (let i = 0; i < 5; i++) event(`ev-d-${i}`, doomed, daysAgo(1));
    for (let i = 0; i < 5; i++) event(`ev-a-${i}`, alive, daysAgo(1));

    await sweepErrors(db, NOW);

    const orphans = db.prepare(`
      SELECT COUNT(*) c FROM error_events e
      LEFT JOIN error_groups g ON g.fingerprint = e.fingerprint
      WHERE g.fingerprint IS NULL
    `).get().c;
    expect(orphans).toBe(0);
    expect(eventIds().length).toBe(5);
  });

  it('creates no rows', async () => {
    group('fp-x', { status: 'resolved', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS + 1) });
    const before = groupIds();
    await sweepErrors(db, NOW);
    const after = groupIds();
    expect(after.every(fp => before.includes(fp)), 'the sweep invented a row').toBe(true);
  });

  it('never resurrects a closed group', async () => {
    group('fp-closed', { status: 'resolved', lastSeen: daysAgo(1) });
    group('fp-ignored', { status: 'ignored', lastSeen: daysAgo(1) });
    await sweepErrors(db, NOW);
    const statuses = db.prepare('SELECT fingerprint, status FROM error_groups ORDER BY fingerprint').all();
    expect(statuses).toEqual([
      { fingerprint: 'fp-closed', status: 'resolved' },
      { fingerprint: 'fp-ignored', status: 'ignored' },
    ]);
  });

  it('is idempotent — a second and third run change nothing and throw nothing', async () => {
    group('fp-keep');
    group('fp-go', { status: 'resolved', lastSeen: daysAgo(CLOSED_GROUP_RETENTION_DAYS + 1) });
    event('ev-keep', 'fp-keep', daysAgo(1));
    event('ev-go', 'fp-keep', daysAgo(EVENT_RETENTION_DAYS + 1));

    const first = await sweepErrors(db, NOW);
    const snapshot = { groups: groupIds(), events: eventIds() };

    expect(await sweepErrors(db, NOW)).toEqual({ groups: 0, events: 0 });
    expect(await sweepErrors(db, NOW)).toEqual({ groups: 0, events: 0 });
    expect({ groups: groupIds(), events: eventIds() }).toEqual(snapshot);
    expect(first.groups + first.events).toBeGreaterThan(0);
  });
});

describe('sweepErrors — the overflow counter', () => {
  it('leaves a live overflow row alone and never recreates one', async () => {
    group(OVERFLOW_FINGERPRINT, { source: 'client', kind: 'ClientGroupCeiling', occurrences: 42, lastSeen: daysAgo(1) });
    await sweepErrors(db, NOW);
    expect(groupIds()).toContain(OVERFLOW_FINGERPRINT);

    // And once it ages out under the ordinary rules, the sweep does not put it
    // back — it creates no rows, so only a real overflow can recreate it.
    db.prepare('UPDATE error_groups SET last_seen_at = ? WHERE fingerprint = ?')
      .run(daysAgo(OPEN_GROUP_RETENTION_DAYS + 1), OVERFLOW_FINGERPRINT);
    await sweepErrors(db, NOW);
    expect(groupIds()).not.toContain(OVERFLOW_FINGERPRINT);
    await sweepErrors(db, NOW);
    expect(groupIds()).not.toContain(OVERFLOW_FINGERPRINT);
  });

  it('expires a stale single-hit overflow row on the client rule like any other', async () => {
    group(OVERFLOW_FINGERPRINT, { source: 'client', occurrences: 1, lastSeen: daysAgo(SINGLE_CLIENT_GROUP_RETENTION_DAYS + 1) });
    await sweepErrors(db, NOW);
    expect(groupIds()).toEqual([]);
  });
});

describe('sweepErrors — works against what recordError actually writes', () => {
  it('expires real recorded data rather than only hand-built rows', async () => {
    await recordError(db, { source: 'server', kind: 'TypeError', message: 'genuine failure' });
    expect(groupIds().length).toBe(1);
    expect(eventIds().length).toBe(1);

    // Age everything past both windows.
    db.prepare('UPDATE error_groups SET last_seen_at = ?').run(daysAgo(OPEN_GROUP_RETENTION_DAYS + 1));
    db.prepare('UPDATE error_events SET occurred_at = ?').run(daysAgo(EVENT_RETENTION_DAYS + 1));

    await sweepErrors(db, NOW);
    expect(groupIds()).toEqual([]);
    expect(eventIds()).toEqual([]);
  });
});

describe('sweepErrors — uses the indexes migration 004 added for it', () => {
  const plan = (sql, ...p) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map(r => r.detail).join(' | ');

  it('plans the event pass against idx_error_events_occurred, not a scan', () => {
    const detail = plan('DELETE FROM error_events WHERE occurred_at < ?', daysAgo(EVENT_RETENTION_DAYS));
    expect(detail).toContain('idx_error_events_occurred');
    expect(detail).not.toMatch(/SCAN error_events(?! USING)/);
  });

  it('plans the closed-group pass against idx_error_groups_triage', () => {
    const detail = plan(
      "DELETE FROM error_groups WHERE status IN ('resolved','ignored') AND last_seen_at < ?",
      daysAgo(CLOSED_GROUP_RETENTION_DAYS)
    );
    expect(detail).toContain('idx_error_groups_triage');
  });

  it('plans the client-single pass against idx_error_groups_source', () => {
    const detail = plan(
      "DELETE FROM error_groups WHERE source = 'client' AND occurrences <= 1 AND last_seen_at < ?",
      daysAgo(SINGLE_CLIENT_GROUP_RETENTION_DAYS)
    );
    expect(detail).toContain('idx_error_groups_source');
  });
});
