/**
 * What the Owner Center can say about this deployment without asking anybody.
 *
 * ── Why it is a module and not two functions in the route ──
 *
 * `server/db.accessSurface.test.js` ratchets the number of modules that reach
 * the database through the module-global handle, because a handle that arrives
 * as a PARAMETER can be given a pooled client during the PostgreSQL port and an
 * imported one cannot. Both queries below take `db`, so the route file that
 * calls them holds the global only to hand it on — which is the direction that
 * ratchet exists to push, and the reason six of the files already on its list
 * are there.
 *
 * It also makes both answerable in a test without an HTTP server.
 */

/**
 * Whether the database will answer a read, and how quickly.
 *
 * ── Why it is asked rather than assumed ──
 *
 * A process can be up, serving, and unable to read: a full disk, a failed
 * failover, a connection pool exhausted by a runaway query. An Owner Center
 * that reported "Database: operational" because a module imported cleanly would
 * be the false green the whole page is written to avoid — and a reader who
 * learns that green means nothing stops reading the greens.
 *
 * ── Read only, deliberately ──
 *
 * `/health` in app.js additionally probes WRITABILITY with a real write, and
 * that is right there: it is polled by a load balancer at a known rate, and
 * "the disk is full" is exactly what should take an instance out of rotation.
 * This endpoint can be polled by an open browser tab instead, and a write per
 * poll is a different thing to put on a database.
 *
 * No error detail escapes. A database error message names paths, hosts and
 * occasionally credentials, and this result is rendered in a browser.
 */
export async function databaseHealth(db) {
  const started = Date.now();
  try {
    await db.prepare('SELECT 1').get();
    return { state: 'ok', latencyMs: Date.now() - started };
  } catch {
    return { state: 'error' };
  }
}

/**
 * The error picture, from this database rather than from a vendor.
 *
 * ── Why not Better Stack ──
 *
 * Every error Better Stack holds was put there by `errorReporter.js`, which
 * wrote `error_events` in the same breath. The local copy is exact where the
 * vendor's is sampled, is retained for thirty days where the free plan keeps
 * three, and is available when the network is not. The second reason is in the
 * header of `server/integrations/betterstack.js`: the credential that could
 * query the vendor is documented as operator-only tooling.
 *
 * ── Counts, never content ──
 *
 * No message, no stack, no fingerprint, no route. Those are the error
 * dashboard's job (`/errors`, gated on `error.read`) and it exists; repeating
 * them here would be a second surface disclosing the same evidence under a
 * different capability, which is how one of the two ends up with weaker rules
 * than the other.
 */
export async function errorTrend(db, now = Date.now()) {
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();

  const [last24h, previous24h, open] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM error_events WHERE occurred_at >= ?').get(dayAgo),
    /* The day BEFORE, with BOTH bounds. Without the upper bound this counts the
       last 48 hours against the last 24 and every trend reads as an
       improvement — a comparison that can only ever be reassuring is worse than
       no comparison. */
    db.prepare('SELECT COUNT(*) AS n FROM error_events WHERE occurred_at >= ? AND occurred_at < ?')
      .get(twoDaysAgo, dayAgo),
    db.prepare("SELECT COUNT(*) AS n FROM error_groups WHERE status = 'open'").get(),
  ]);

  const recent = Number(last24h?.n ?? 0);
  const before = Number(previous24h?.n ?? 0);

  return {
    last24h: recent,
    previous24h: before,
    /* `null` when there is nothing to compare against. Every increase from zero
       is infinite, and "+∞%" is not a fact anybody can act on. */
    changePercent: before === 0 ? null : Math.round(((recent - before) / before) * 100),
    openGroups: Number(open?.n ?? 0),
    /**
     * Named so the page can say what the window actually is.
     *
     * `error_events` is swept at 30 days and capped at 50 rows per group
     * (see `errorReporter.js`), so any chart drawn from it is a window over
     * RETAINED EVIDENCE and not an all-time total. A dashboard that implies
     * otherwise is one somebody will eventually quote in a report.
     */
    windowDays: 30,
  };
}
