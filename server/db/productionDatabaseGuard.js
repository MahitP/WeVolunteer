/**
 * Refuse to let a non-production process talk to the production database.
 *
 * ── The accident this exists to prevent ──
 *
 * There is no code path that intends it, and that is exactly why it happens.
 * The realistic sequence is mundane: production `DATABASE_URL` is pasted into a
 * Vercel project's environment without narrowing the scope, so every Preview
 * deployment of every pull request now holds production credentials. A preview
 * of a branch that adds a migration, or seeds fixtures, or exercises the
 * retention worker, then writes to the live database — and nothing anywhere
 * says so, because from the application's point of view it is simply a
 * correctly configured database connection.
 *
 * The same shape occurs locally: a developer exports the production URL to run
 * one read-only query, forgets, and the next `npm run dev` boots against it.
 *
 * ── Why a fingerprint rather than comparing URLs ──
 *
 * The guard has to be able to say "this is production" in an environment that
 * must NOT hold the production URL — that is the entire point. So it compares a
 * fingerprint instead: a SHA-256 over `host:port/database`, with the username
 * and password deliberately excluded.
 *
 * Two properties follow, and both are load-bearing:
 *
 *   1. The fingerprint is NOT a secret. It is a hash of a hostname and a
 *      database name, so it is safe to commit, to paste into a preview
 *      environment, and to print in an error message. An environment can
 *      therefore be told what production looks like without being told how to
 *      reach it.
 *   2. Credentials are excluded, so rotating the database password does not
 *      silently disable the guard — which is precisely when a guard failing
 *      open would be least noticed.
 *
 * The hashed material is `user@host:port/database`. The PASSWORD is excluded
 * and the username is not, and each half of that is deliberate:
 *
 *   • Excluding the password is what makes rotation safe. A guard that stopped
 *     matching when the password changed would fail open at exactly the moment
 *     nobody is watching for it.
 *   • Including the username is what makes the fingerprint identify a DATABASE
 *     rather than a route to one. On a managed provider the hostname is often
 *     shared: every Supabase project in a region is reached through the same
 *     `aws-0-<region>.pooler.supabase.com`, with the default database name
 *     `postgres`, and the project is identified by the pooler USERNAME
 *     (`postgres.<project-ref>`). Hashing host and database alone therefore
 *     produced one fingerprint for every project in a region — so a legitimate
 *     staging database fingerprinted identically to production and would have
 *     been refused, which is the "cries wolf" outcome the opt-in design below
 *     exists to avoid.
 *
 * ── One database, several spellings: the list is the answer ──
 *
 * An earlier version of this comment claimed the guard "still fires through
 * the shapes that defeat string comparison … the connection-pooler port
 * swapped for the direct one." That was FALSE, and believing it was worse than
 * not having the guard. Host and port are both inside the hash, so every
 * endpoint for one database fingerprints differently:
 *
 *     aws-0-us-east-2.pooler.supabase.com:5432   session pooler
 *     aws-0-us-east-2.pooler.supabase.com:6543   transaction pooler
 *     db.<project-ref>.supabase.co:5432          direct connection
 *
 * `docs/operations/database-credential-rotation.md` tells an operator to use
 * the direct endpoint, so the one URL a person is most likely to be holding in
 * a shell was the one the guard passed silently.
 *
 * A single fingerprint cannot express "this database, however you reached it",
 * so `WEV_PRODUCTION_DB_FINGERPRINT` accepts a COMMA-SEPARATED list and a match
 * against any entry is a match. Add every endpoint the deployment can be
 * reached through; `bin/db-fingerprint.mjs` prints one per URL.
 *
 * ── Fails closed, but only when it has been told what to close against ──
 *
 * With `WEV_PRODUCTION_DB_FINGERPRINT` unset the guard is inert. That is a
 * deliberate limit and not an oversight: a guard that guessed which databases
 * are production would refuse legitimate staging deployments, and a guard that
 * cries wolf gets disabled. Setting the fingerprint is a launch-checklist item,
 * and `describeFingerprint()` exists so an operator can obtain it without ever
 * printing a URL.
 */
import { createHash } from 'crypto';

/**
 * Which deployment this process believes it is.
 *
 * `VERCEL_ENV` is set by the platform itself to `production`, `preview` or
 * `development`, and it is the signal worth trusting here BECAUSE it is not
 * ours: copying production environment variables into a Preview deployment
 * copies `NODE_ENV=production` along with them, and a Preview build that
 * believed it was production would sail straight past this check. `VERCEL_ENV`
 * is stamped by the platform per deployment and cannot be inherited that way.
 *
 * Off Vercel there is no such external witness, so `NODE_ENV` is the fallback.
 */
export function deploymentEnvironment(env = process.env) {
  if (env.VERCEL_ENV) return env.VERCEL_ENV;
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * A stable, non-secret identifier for the database a connection string names.
 *
 * Returns null for anything unparseable rather than throwing: an unusable URL
 * is a different failure, reported by a different check with a better message,
 * and this guard must not be the thing that turns a typo into a stack trace.
 */
export function databaseFingerprint(connectionString) {
  if (!connectionString) return null;
  let user, host, port, database;
  try {
    const u = new URL(connectionString);
    host = u.hostname.toLowerCase();
    /* Default named explicitly. Otherwise the same server reached once as
       `host/db` and once as `host:5432/db` fingerprints differently, and the
       guard would pass for one of them. */
    port = u.port || '5432';
    user = decodeURIComponent(u.username || '');
    /**
     * An absent path means the DEFAULT database, not "no database".
     *
     * `pg` resolves a path-less connection string to a database named after the
     * user (node_modules/pg/lib/connection-parameters.js), and on Supabase the
     * direct-connection user is `postgres` — whose default database is also
     * `postgres`. So `postgres://postgres:pw@db.<ref>.supabase.co:5432` reaches
     * the production database, and returning null here made the guard inert for
     * it: a fail-open on the shortest URL somebody could type.
     */
    database = decodeURIComponent(u.pathname.replace(/^\//, '')) || user;
  } catch {
    return null;
  }
  if (!host || !database) return null;
  return createHash('sha256').update(`${user}@${host}:${port}/${database}`).digest('hex').slice(0, 32);
}

/** Human-facing helper: what to put in WEV_PRODUCTION_DB_FINGERPRINT. */
export function describeFingerprint(connectionString) {
  const fp = databaseFingerprint(connectionString);
  return fp
    ? `WEV_PRODUCTION_DB_FINGERPRINT=${fp}`
    : 'could not fingerprint that connection string (is it a valid postgres:// URL?)';
}

/**
 * Throws when a non-production deployment is pointed at the production database.
 *
 * Deliberately says nothing about the URL it was given beyond the fingerprint,
 * which is not a secret. Error text reaches build logs, and on Vercel those are
 * visible to everyone with repository access.
 */
export function assertNotProductionDatabase(env = process.env, connectionString = env.DATABASE_URL) {
  /* A comma-separated LIST — one database, several endpoints. Trimmed because
     a systemd `EnvironmentFile` does not always strip trailing whitespace, and
     a fingerprint that silently never matches is a guard that is not there. */
  const expected = String(env.WEV_PRODUCTION_DB_FINGERPRINT || '')
    .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (expected.length === 0) return { checked: false, reason: 'no fingerprint configured' };

  const actual = databaseFingerprint(connectionString);
  if (!actual) return { checked: false, reason: 'connection string not fingerprintable' };

  const environment = deploymentEnvironment(env);
  const isProduction = environment === 'production';
  const matches = expected.includes(actual);

  if (matches && !isProduction) {
    throw new Error(
      `FATAL: this is a ${environment} deployment, and DATABASE_URL points at the\n`
      + '  PRODUCTION database.\n\n'
      + `  fingerprint: ${actual}\n\n`
      + '  A preview or development process shares no code path with production by\n'
      + '  intent, but it does share migrations, seeds, workers and retention — any\n'
      + '  of which would write to real students\' records.\n\n'
      + '  Point this deployment at its own database. If this genuinely IS\n'
      + '  production, the deployment environment is mislabelled: check VERCEL_ENV\n'
      + '  (or NODE_ENV off Vercel), and do not "fix" this by clearing\n'
      + '  WEV_PRODUCTION_DB_FINGERPRINT.'
    );
  }

  /**
   * The inverse mistake, reported but not fatal.
   *
   * Production pointed at something that is not the production database is
   * usually a failed cutover or a stale variable. It is NOT made fatal here,
   * because the legitimate case — a planned migration to a new database whose
   * fingerprint has not been updated yet — is real, and refusing to boot would
   * turn a routine move into an outage. It is loud instead.
   */
  if (!matches && isProduction) {
    return {
      checked: true,
      warning:
        'WARNING: NODE_ENV/VERCEL_ENV says production, but DATABASE_URL does not match\n'
        + `  WEV_PRODUCTION_DB_FINGERPRINT (expected one of ${expected.join(', ')}, got ${actual}).\n`
        + '  Either this deployment is pointed at the wrong database, or the\n'
        + '  fingerprint is stale after a planned move.'
    };
  }

  return { checked: true, environment, matches };
}
