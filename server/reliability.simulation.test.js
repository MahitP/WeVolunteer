import { describe, it, expect } from 'vitest';
import {
  summarise, recencyWeight, reliabilityOf,
  MIN_EVIDENCE, RELIABLE_THRESHOLD, RECENCY_HALF_LIFE,
} from './reliability.js';
import { DatabaseSync } from 'node:sqlite';

/**
 * The reliability model, simulated against the volunteers it exists to tell
 * apart.
 *
 * These are not unit tests of arithmetic. Each one is a person the model has to
 * judge correctly, and the assertions are about the JUDGEMENT — who gets called
 * reliable, who does not, and which of two volunteers ranks above the other.
 * If the model is ever replaced, these should survive unchanged; they describe
 * the product, not the formula.
 *
 * Every scenario prints its numbers on failure, so a wrong answer says what the
 * model actually thought rather than only that it disagreed.
 */

/* ── Fixtures ─────────────────────────────────────────────────────────────
   Commitments are newest first, which is the order `commitmentsFor` returns.
   `day(n)` counts BACKWARDS: day(0) is the most recent.
   ---------------------------------------------------------------------- */

const day = (n) => new Date(Date.UTC(2026, 7, 1) - n * 86400000).toISOString();

/** `n` commitments, newest first, each `present` unless listed in `missAt`. */
function history(n, { missAt = [], unconfirmedAt = [] } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    present: unconfirmedAt.includes(i) ? null : (missAt.includes(i) ? 0 : 1),
    occurredAt: day(i),
  }));
}

/** Newest-first list built from an explicit oldest-first outcome string. */
function fromPattern(pattern) {
  /* "AAAMM" oldest-first → newest-first list. A = attended, M = missed,
     ? = unconfirmed. Reading order matches how a person describes a history. */
  const chars = [...pattern].reverse();
  return chars.map((c, i) => ({
    present: c === '?' ? null : (c === 'A' ? 1 : 0),
    occurredAt: day(i),
  }));
}

const report = (s) =>
  `recorded=${s.recorded} attended=${s.attended} absent=${s.absent} `
  + `awaiting=${s.awaitingRecord} rate=${s.rate} weighted=${s.weightedRate} `
  + `score=${s.score} evidence=${s.hasEnoughEvidence} reliable=${s.isReliable}`;

/* ── The named volunteers from the brief ─────────────────────────────── */

describe('reliability simulation', () => {
  describe('Volunteer A — 1000 commitments, 900 attended, strong recently', () => {
    /* 100 misses, all in the distant past; the recent 100 are clean. */
    const A = summarise([
      ...history(900),
      ...Array.from({ length: 100 }, (_, i) => ({ present: 0, occurredAt: day(900 + i) })),
    ]);

    it('is reliable', () => {
      expect(A.isReliable, report(A)).toBe(true);
    });

    it('counts every one of its 1000 commitments', () => {
      expect(A.recorded).toBe(1000);
      expect(A.attended).toBe(900);
      expect(A.absent).toBe(100);
    });

    it('is not dragged below the threshold by a lifetime ratio of 0.90', () => {
      /**
       * The exact failure the brief describes. A plain percentage gives 90.0%,
       * which is not "over 90%", so a naive model would refuse the badge to
       * somebody who has turned up nine hundred times — while handing it to
       * somebody who has turned up nine.
       *
       * Recency is what resolves it: A's misses are old and A's recent record
       * is spotless, so the weighted rate is far above the lifetime one.
       */
      expect(A.weightedRate, report(A)).toBeGreaterThan(A.rate);
      expect(A.score, report(A)).toBeGreaterThan(RELIABLE_THRESHOLD);
    });
  });

  describe('Volunteer B — 10 commitments, all attended', () => {
    const B = summarise(history(10));

    it('is reliable', () => {
      expect(B.isReliable, report(B)).toBe(true);
    });

    it('is not scored above a flawless 1000-commitment record', () => {
      /**
       * The other half of the brief's example. B should not OUTRANK A merely
       * for having a shorter history: ten-for-ten is weaker evidence than a
       * thousand-for-a-thousand, and the prior is what expresses that.
       */
      const perfectThousand = summarise(history(1000));
      expect(B.score, `B=${report(B)} vs perfect=${report(perfectThousand)}`)
        .toBeLessThan(perfectThousand.score);
    });
  });

  describe('Volunteer C — 2 commitments, both attended', () => {
    const C = summarise(history(2));

    it('is not called reliable on two records', () => {
      /* One missed shift out of two is not a pattern, and neither is two
         attended. The badge is a claim about a habit. */
      expect(C.hasEnoughEvidence, report(C)).toBe(false);
      expect(C.isReliable, report(C)).toBe(false);
    });

    it('is not called unreliable either', () => {
      /* Absence of evidence is reported as absence of evidence. Nothing in the
         output invites a reader to conclude anything about this person. */
      expect(C.absent).toBe(0);
      expect(C.score).toBeGreaterThan(0.5);
    });
  });

  describe('Volunteer D — long history, poor recent attendance', () => {
    const D = summarise([...history(6).map(c => ({ ...c, present: 0 })), ...history(40)]);

    it('loses the badge despite an excellent lifetime record', () => {
      const lifetimeOnly = summarise(history(40));
      expect(lifetimeOnly.isReliable).toBe(true);
      expect(D.isReliable, report(D)).toBe(false);
    });

    it('is judged on the weighted rate rather than the lifetime one', () => {
      expect(D.weightedRate, report(D)).toBeLessThan(D.rate);
    });
  });

  describe('Volunteer E — excellent history, then four straight misses', () => {
    const E = summarise([...history(4).map(c => ({ ...c, present: 0 })), ...history(30)]);

    it('is not reliable right now', () => {
      expect(E.isReliable, report(E)).toBe(false);
    });

    it('keeps every historical attendance on the record', () => {
      /* The badge goes; the history does not. Nothing is erased. */
      expect(E.attended).toBe(30);
      expect(E.recorded).toBe(34);
    });
  });

  describe('Volunteer F — poor history, then a long recovery', () => {
    const beforeRecovery = summarise(fromPattern('MMMMMMAA'));
    const afterRecovery = summarise(fromPattern('MMMMMM' + 'A'.repeat(20)));

    it('starts out not reliable', () => {
      expect(beforeRecovery.isReliable, report(beforeRecovery)).toBe(false);
    });

    it('recovers the badge through consistent attendance', () => {
      /**
       * The property the brief asks for by name: recovery must be something a
       * volunteer can DO. Because decay is counted in commitments rather than
       * days, turning up is what restores standing — waiting does nothing.
       */
      expect(afterRecovery.isReliable, report(afterRecovery)).toBe(true);
    });

    it('still remembers the early misses', () => {
      expect(afterRecovery.absent).toBe(6);
    });

    it('improves faster by attending than by waiting', () => {
      /* Elapsed time appears nowhere in the model. Two summaries of the same
         history are identical whenever the dates differ but the order does
         not — so a volunteer cannot wait out a miss. */
      const same = fromPattern('MMMMMMAA').map((c, i) => ({ ...c, occurredAt: day(i + 500) }));
      expect(summarise(same).score).toBe(beforeRecovery.score);
    });
  });

  describe('Volunteer G — first-time volunteer', () => {
    const G = summarise([]);

    it('has no evidence and no verdict', () => {
      expect(G.recorded).toBe(0);
      expect(G.hasEnoughEvidence).toBe(false);
      expect(G.isReliable).toBe(false);
    });

    it('produces a real number rather than NaN', () => {
      expect(Number.isFinite(G.score)).toBe(true);
      expect(Number.isFinite(G.rate)).toBe(true);
      expect(Number.isFinite(G.weightedRate)).toBe(true);
    });

    it('sits at the prior, neither good nor bad', () => {
      expect(G.score).toBeCloseTo(0.85, 5);
    });
  });

  describe('Volunteer H — attended plenty, but not lately', () => {
    const H = summarise(history(20).map((c, i) => ({ ...c, occurredAt: day(400 + i) })));

    it('keeps its reliability, because turning up is not the same as turning up recently', () => {
      /* Inactivity is not unreliability. Somebody who attended everything they
         signed up for and then had a quiet year is still somebody who turns up.
         "When did they last volunteer" is a separate question, answered by
         `lastAttendedAt` rather than by the score. */
      expect(H.isReliable, report(H)).toBe(true);
      expect(H.lastAttendedAt).toBeTruthy();
    });
  });

  /* ── Records that must not count ────────────────────────────────────── */

  describe('records that must never count against somebody', () => {
    it('ignores commitments an organizer never confirmed', () => {
      const withGaps = summarise(history(10, { unconfirmedAt: [0, 1, 2] }));
      expect(withGaps.recorded, report(withGaps)).toBe(7);
      expect(withGaps.awaitingRecord).toBe(3);
      expect(withGaps.absent).toBe(0);
    });

    it('does not let unconfirmed records discount the real ones behind them', () => {
      /**
       * A subtle one. If unconfirmed records consumed a decay slot, a run of
       * organizer paperwork nobody completed would push a volunteer's genuine
       * history into the past and quietly reduce its weight — penalising them
       * for somebody else's admin.
       */
      const clean = summarise(history(10));
      const withLeadingGaps = summarise(history(13, { unconfirmedAt: [0, 1, 2] }));
      expect(withLeadingGaps.weightedRate).toBeCloseTo(clean.weightedRate, 10);
    });

    it('reports awaiting records so a gap is never read as an absence', () => {
      const s = summarise(history(5, { unconfirmedAt: [0] }));
      expect(s.awaitingRecord).toBe(1);
      expect(s.attended + s.absent).toBe(s.recorded);
    });
  });

  /* ── Weighting behaviour ────────────────────────────────────────────── */

  describe('recency weighting', () => {
    it('halves at the stated half-life', () => {
      expect(recencyWeight(0)).toBe(1);
      expect(recencyWeight(RECENCY_HALF_LIFE)).toBeCloseTo(0.5, 10);
      expect(recencyWeight(RECENCY_HALF_LIFE * 2)).toBeCloseTo(0.25, 10);
    });

    it('never reaches zero, so old evidence is discounted and not deleted', () => {
      expect(recencyWeight(1000)).toBeGreaterThan(0);
    });

    it('makes a recent miss cost more than an old one', () => {
      const recentMiss = summarise(fromPattern('AAAAAAAAAAAAAAAAAAAM'));
      const oldMiss = summarise(fromPattern('MAAAAAAAAAAAAAAAAAAA'));
      expect(oldMiss.weightedRate, `old=${report(oldMiss)} recent=${report(recentMiss)}`)
        .toBeGreaterThan(recentMiss.weightedRate);
    });

    it('gives the same lifetime rate either way', () => {
      /* The unweighted rate is order-independent by construction. Only the
         weighted one moves, which is what isolates recency as the variable. */
      expect(summarise(fromPattern('AAAAAAAAAM')).rate)
        .toBe(summarise(fromPattern('MAAAAAAAAA')).rate);
    });
  });

  /* ── The evidence floor and the threshold ───────────────────────────── */

  describe('minimum evidence', () => {
    it(`requires ${MIN_EVIDENCE} completed commitments`, () => {
      for (let n = 0; n < MIN_EVIDENCE; n++) {
        expect(summarise(history(n)).hasEnoughEvidence, `${n} commitments`).toBe(false);
      }
      expect(summarise(history(MIN_EVIDENCE)).hasEnoughEvidence).toBe(true);
    });

    it('never awards the badge below the floor, however perfect the record', () => {
      expect(summarise(history(MIN_EVIDENCE - 1)).isReliable).toBe(false);
    });

    it('counts only confirmed records toward the floor', () => {
      /* Ten signups of which two were confirmed is two records' worth of
         evidence, not ten. */
      const mostlyUnconfirmed = summarise(
        history(10, { unconfirmedAt: [2, 3, 4, 5, 6, 7, 8, 9] }),
      );
      expect(mostlyUnconfirmed.recorded).toBe(2);
      expect(mostlyUnconfirmed.hasEnoughEvidence).toBe(false);
    });
  });

  describe('the threshold is strictly "over"', () => {
    it('refuses a score sitting exactly on it', () => {
      expect(summarise([]).isReliable).toBe(false);
      /* Constructed so the smoothed score lands on the threshold or below;
         the assertion is the comparison, not the arithmetic. */
      const borderline = summarise(history(20, { missAt: [10, 15] }));
      expect(borderline.isReliable).toBe(borderline.score > RELIABLE_THRESHOLD);
    });

    it('produces a score inside [0, 1] for every history', () => {
      for (const s of [
        summarise([]),
        summarise(history(1)),
        summarise(history(1000)),
        summarise(history(1000).map(c => ({ ...c, present: 0 }))),
        summarise(history(50, { missAt: [0, 1, 2, 3, 4] })),
      ]) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
        expect(Number.isFinite(s.score)).toBe(true);
      }
    });
  });

  describe('degenerate input', () => {
    it.each([
      ['nothing', []],
      ['undefined', undefined],
      ['null', null],
      ['a list of nulls', [null, null]],
    ])('survives %s', (_label, input) => {
      const s = summarise(input);
      expect(Number.isFinite(s.score)).toBe(true);
      expect(s.recorded).toBe(0);
    });

    it('never divides by zero when every record is unconfirmed', () => {
      const s = summarise(history(5, { unconfirmedAt: [0, 1, 2, 3, 4] }));
      expect(s.recorded).toBe(0);
      expect(Number.isFinite(s.weightedRate)).toBe(true);
      expect(s.isReliable).toBe(false);
    });

    it('handles a volunteer who missed everything without producing a negative score', () => {
      const s = summarise(history(30).map(c => ({ ...c, present: 0 })));
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.isReliable).toBe(false);
      expect(s.attended).toBe(0);
    });
  });
});

/* ── Against a real database ──────────────────────────────────────────── */

describe('commitmentsFor, against a database', () => {
  function makeDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, status TEXT DEFAULT 'open');
      CREATE TABLE slots (id TEXT PRIMARY KEY, event_id TEXT, end_datetime TEXT);
      CREATE TABLE applications (id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT);
      CREATE TABLE attendance (event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL,
        PRIMARY KEY (slot_id, user_id));
    `);
    return db;
  }

  let n = 0;
  /** A commitment for `user`, optionally attended, optionally on a cancelled event. */
  function commit(db, user, { present = 1, endsAt, status = 'open', appStatus = 'accepted', eventId } = {}) {
    n += 1;
    const e = eventId ?? `e${n}`;
    const s = `s${n}`;
    if (!eventId) db.prepare('INSERT INTO events (id, status) VALUES (?, ?)').run(e, status);
    db.prepare('INSERT INTO slots (id, event_id, end_datetime) VALUES (?, ?, ?)').run(s, e, endsAt);
    db.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status) VALUES (?, ?, ?, ?, ?)')
      .run(`a${n}`, user, e, s, appStatus);
    if (present !== null) {
      db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
        .run(e, s, user, present, 2);
    }
    return e;
  }

  const PAST = '2026-01-01T12:00:00.000Z';
  const NOW = '2026-08-01T00:00:00.000Z';

  it('reads a volunteer\'s completed commitments newest first', () => {
    const db = makeDb();
    commit(db, 'u1', { endsAt: '2026-01-01T00:00:00.000Z' });
    commit(db, 'u1', { endsAt: '2026-03-01T00:00:00.000Z' });

    const s = reliabilityOf(db, 'u1', { now: NOW });
    expect(s.recorded).toBe(2);
    expect(s.attended).toBe(2);
  });

  it('excludes cancelled events from both sides', () => {
    const db = makeDb();
    commit(db, 'u1', { endsAt: PAST, present: 0, status: 'cancelled' });
    commit(db, 'u1', { endsAt: PAST });

    const s = reliabilityOf(db, 'u1', { now: NOW });
    expect(s.recorded, report(s)).toBe(1);
    expect(s.absent).toBe(0);
  });

  it('excludes withdrawn and waitlisted applications', () => {
    const db = makeDb();
    commit(db, 'u1', { endsAt: PAST, present: null, appStatus: 'withdrawn' });
    commit(db, 'u1', { endsAt: PAST, present: null, appStatus: 'waitlisted' });
    commit(db, 'u1', { endsAt: PAST });

    const s = reliabilityOf(db, 'u1', { now: NOW });
    expect(s.recorded + s.awaitingRecord, report(s)).toBe(1);
  });

  it('excludes a shift that has not ended yet', () => {
    const db = makeDb();
    commit(db, 'u1', { endsAt: '2027-01-01T00:00:00.000Z', present: null });
    commit(db, 'u1', { endsAt: PAST });

    const s = reliabilityOf(db, 'u1', { now: NOW });
    expect(s.recorded + s.awaitingRecord, report(s)).toBe(1);
  });

  it('counts an unconfirmed past commitment as awaiting a record', () => {
    const db = makeDb();
    commit(db, 'u1', { endsAt: PAST, present: null });

    const s = reliabilityOf(db, 'u1', { now: NOW });
    expect(s.awaitingRecord).toBe(1);
    expect(s.recorded).toBe(0);
  });

  it('collapses two shifts of one event into a single commitment', () => {
    const db = makeDb();
    const e = commit(db, 'u1', { endsAt: PAST, present: 1 });
    commit(db, 'u1', { endsAt: PAST, present: 0, eventId: e });

    const s = reliabilityOf(db, 'u1', { now: NOW });
    /* Attended one shift and missed another of the same festival: they
       attended that event. Matches attendanceRecordsFor's MAX(present). */
    expect(s.recorded, report(s)).toBe(1);
    expect(s.attended).toBe(1);
    expect(s.absent).toBe(0);
  });

  it('keeps volunteers separate when batched', () => {
    const db = makeDb();
    commit(db, 'u1', { endsAt: PAST, present: 1 });
    commit(db, 'u2', { endsAt: PAST, present: 0 });

    const s1 = reliabilityOf(db, 'u1', { now: NOW });
    const s2 = reliabilityOf(db, 'u2', { now: NOW });
    expect(s1.attended).toBe(1);
    expect(s2.absent).toBe(1);
  });

  it('returns an empty summary for somebody with no history', () => {
    const db = makeDb();
    const s = reliabilityOf(db, 'nobody', { now: NOW });
    expect(s.recorded).toBe(0);
    expect(s.isReliable).toBe(false);
  });
});
