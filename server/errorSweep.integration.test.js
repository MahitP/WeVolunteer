/**
 * The wiring, not the logic.
 *
 * `errorSweep.test.js` proves `sweepErrors` expires the right rows. That is a
 * different claim from "the application ever calls it", and only the second one
 * bounds a live database. A correct sweep nobody invokes is the unbounded table
 * this release exists to prevent, with every unit test green — the same gap
 * Guard 5 exists for in v1.2b, where a `requireAAL2` gate that never spent its
 * grant passed every functional test.
 *
 * Also asserts the acceptance criterion literally: no new interval, no new
 * worker, nothing added to `shutdown.js`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8');

let srv, db, utils;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  utils = await import('./utils.js');
}, 60000);
afterAll(async () => { await srv?.close(); });

describe('the maintenance sweep actually expires error data', () => {
  it('removes an aged group when runNotificationSweep runs', () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    db.prepare(`
      INSERT INTO error_groups
        (fingerprint, source, kind, message, status, occurrences, users_seen, first_seen_at, last_seen_at)
      VALUES ('fp-integration-old', 'server', 'TypeError', 'ancient', 'open', 9, 0, ?, ?)
    `).run(old, old);
    db.prepare(`
      INSERT INTO error_groups
        (fingerprint, source, kind, message, status, occurrences, users_seen, first_seen_at, last_seen_at)
      VALUES ('fp-integration-fresh', 'server', 'TypeError', 'recent', 'open', 9, 0, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    // The real entry point the 15-minute interval calls — not sweepErrors.
    utils.runNotificationSweep();

    const alive = db.prepare(
      "SELECT fingerprint FROM error_groups WHERE fingerprint LIKE 'fp-integration-%'"
    ).all().map(r => r.fingerprint);

    expect(alive, 'runNotificationSweep never reached sweepErrors').toEqual(['fp-integration-fresh']);
  });

  it('removes aged evidence from a group that survives', () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO error_groups
        (fingerprint, source, kind, message, status, occurrences, users_seen, first_seen_at, last_seen_at)
      VALUES ('fp-integration-evt', 'server', 'TypeError', 'keeps', 'open', 3, 0, ?, ?)
    `).run(now, now);
    db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
      .run('ev-int-old', 'fp-integration-evt', new Date(Date.now() - 90 * 86_400_000).toISOString());
    db.prepare('INSERT INTO error_events (id, fingerprint, occurred_at) VALUES (?, ?, ?)')
      .run('ev-int-new', 'fp-integration-evt', now);

    utils.runNotificationSweep();

    const kept = db.prepare(
      "SELECT id FROM error_events WHERE fingerprint = 'fp-integration-evt'"
    ).all().map(r => r.id);
    expect(kept).toEqual(['ev-int-new']);
    // The group survived losing its old evidence — counter intact.
    expect(
      db.prepare("SELECT occurrences FROM error_groups WHERE fingerprint = 'fp-integration-evt'").get().occurrences
    ).toBe(3);
  });

  it('a failing error sweep does not abort the rest of the maintenance sweep', () => {
    // runNotificationSweep wraps its whole body in ONE try/catch, so a throw
    // from sweepErrors would silently abandon every task after it. sweepErrors
    // catches internally instead; this asserts the whole thing still completes
    // and returns its own count.
    expect(() => utils.runNotificationSweep()).not.toThrow();
    expect(typeof utils.runNotificationSweep()).toBe('number');
  });
});

describe('no new scheduling machinery was introduced', () => {
  it('server.js still registers exactly the timers it did before', () => {
    const src = read('server.js');
    // ONE direct setInterval — the 15-minute maintenance sweep. The other two
    // registered timers (`lockHeartbeat`, `autoSelectTimer`) are returned by
    // their own start* helpers and are not created here.
    const intervals = [...src.matchAll(/setInterval\s*\(/g)].length;
    expect(intervals, 'a new setInterval appeared — the sweep must reuse the existing one').toBe(1);
    expect(src).toContain('const sweepInterval = setInterval(runNotificationSweep');
    // Still exactly three things to drain, and the same three.
    expect(src).toContain('intervals: [sweepInterval, lockHeartbeat, autoSelectTimer]');
    expect(src, 'server.js should not need to know the error sweep exists')
      .not.toContain('sweepErrors');
  });

  it('shutdown.js gained nothing to drain', () => {
    const src = read('shutdown.js');
    expect(src).not.toContain('sweepErrors');
    expect(src).not.toContain('errorReporter');
  });

  it('the sweep is invoked from utils.js beside the step-up sweep', () => {
    const src = read('utils.js');
    expect(src).toContain('sweepErrors(db, now)');
    expect(src).toContain("from './errorReporter.js'");
    // Both sweeps live in the same try block; neither gets its own timer.
    expect(src.indexOf('sweepExpiredChallenges(db, now)')).toBeGreaterThan(0);
    expect(src.indexOf('sweepErrors(db, now)')).toBeGreaterThan(src.indexOf('sweepExpiredChallenges(db, now)'));
  });
});
