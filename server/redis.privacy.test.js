/**
 * The boundary around Upstash: what may be sent there, and what may not.
 *
 * ── Why these are source scans rather than behavioural tests ──
 *
 * The same reason `envDocumentation.test.js` and `db.accessSurface.test.js`
 * scan source. The failures being prevented are ones that arrive with a future
 * edit — a new cache in a route that holds personal data, a credential
 * accidentally given a `VITE_` name — and a behavioural test only covers the
 * call sites that exist today. A scan covers the ones nobody has written yet,
 * which is the whole premise of a guard.
 *
 * Redis in this application is a **derived, non-authoritative store**. Every
 * key in it is reconstructible by doing the work again, nothing in it is ever
 * read as a source of truth, and no application data moves out of SQL to reach
 * it. These tests are what keeps that true.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

function filesUnder(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === 'node_modules' || name === 'dist' || name === 'scratch' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) { filesUnder(full, exts, out); continue; }
    if (exts.some(ext => name.endsWith(ext))) out.push(full);
  }
  return out;
}

const read = (p) => readFileSync(p, 'utf8');

/**
 * Source with comments removed.
 *
 * The scans below look for key literals and log lines, and this file's own
 * subjects are heavily commented — `redisConfig.js` spells out what a
 * wrongly-concatenated prefix would look like, in prose, which a naive scan
 * reads as the very defect it is warning about. Stripping comments is what
 * makes these guards assert something about the CODE.
 */
function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('credentials never reach the browser', () => {
  /**
   * The rule Pinecone's integration records and this one inherits: a `VITE_`
   * prefix compiles a value into the bundle, where a database token is a
   * write credential anyone can read with View Source.
   */
  it('no VITE_-prefixed Upstash variable exists anywhere in the repository', () => {
    const files = [
      ...filesUnder(path.join(repoRoot, 'src'), ['.js', '.jsx', '.css']),
      ...filesUnder(path.join(repoRoot, 'server'), ['.js']),
      ...filesUnder(path.join(repoRoot, 'bin'), ['.mjs', '.js', '.sh']),
      path.join(repoRoot, '.env.example'),
      path.join(repoRoot, '.env.production.example'),
      path.join(repoRoot, 'deploy', 'wevolunteer.env.example'),
      path.join(repoRoot, 'vite.config.js'),
    ];
    for (const file of files) {
      expect(read(file), `${path.relative(repoRoot, file)} names a VITE_ Upstash variable`)
        .not.toMatch(/VITE_[A-Z0-9_]*(UPSTASH|REDIS)/);
    }
  });

  it('no client source reads an Upstash variable at all', () => {
    for (const file of filesUnder(path.join(repoRoot, 'src'), ['.js', '.jsx'])) {
      expect(read(file), `${path.relative(repoRoot, file)} references Upstash`)
        .not.toMatch(/UPSTASH_REDIS_REST/);
    }
  });

  it('the token is never interpolated into a log line', () => {
    /* The error paths record a STATUS and a failure kind, never the request —
       a request carries the header that carries the token. */
    for (const file of filesUnder(path.join(repoRoot, 'server', 'redis'), ['.js'])) {
      const src = code(file);
      const logs = src.match(/console\.[a-z]+\([^)]*\)/g) ?? [];
      for (const line of logs) {
        expect(line, `${path.basename(file)}: ${line}`).not.toMatch(/token|Authorization|cfg\.token/i);
      }
    }
  });
});

describe('the travel-time route is not a caller', () => {
  /**
   * `routes/travelRoutes.js` promises that a minor's coordinates are "never
   * persisted. No column, no row, nowhere." Sending them to a third party
   * breaks that promise, and hashing the key does not rescue it — the promise
   * is about where the data goes, not about how it is encoded.
   *
   * This is the single most important privacy decision in the Redis change, so
   * it is asserted rather than left to a comment.
   */
  it('does not import anything from server/redis/', () => {
    const src = read(path.join(repoRoot, 'server', 'routes', 'travelRoutes.js'));
    expect(src).not.toMatch(/from\s+['"]\.\.\/redis\//);
  });

  it('says why, so the next person to add a cache there reads the reason first', () => {
    const src = read(path.join(repoRoot, 'server', 'routes', 'travelRoutes.js'));
    expect(src).toMatch(/NOT a caller of the Redis cache/);
  });
});

describe('what the keyspace may contain', () => {
  it('every key is built from the environment prefix, never a bare literal', () => {
    /* One database on the free plan means development, test and production
       share a keyspace. A key built without `keyPrefix()` is a key a test can
       write into production's counters. */
    for (const file of filesUnder(path.join(repoRoot, 'server', 'redis'), ['.js'])) {
      /* `redisConfig.js` is where `wev:` is defined, so it is the one file that
         must contain the literal. Everywhere else, containing it means a key
         was assembled without going through the environment prefix. */
      if (file.endsWith('redisConfig.js')) continue;
      const src = code(file);
      const templates = src.match(/`wev:[^`]*`/g) ?? [];
      for (const t of templates) {
        expect(t, `${path.basename(file)} hard-codes a key prefix: ${t}`).toMatch(/\$\{keyPrefix\(\)\}|\$\{prefix\}/);
      }
    }
  });

  it('caller-supplied key segments are hashed at every construction site', () => {
    /* Two reasons, and the second is the one that matters: Upstash takes
       commands as JSON arrays so a raw value cannot change the command, but a
       key made from an email address is a list of who tried to sign in,
       stored on somebody else's infrastructure. */
    const sites = [];
    for (const file of filesUnder(path.join(repoRoot, 'server', 'redis'), ['.js'])) {
      if (file.endsWith('redisConfig.js')) continue;
      for (const line of code(file).split('\n')) {
        if (/return\s+`\$\{keyPrefix\(\)\}/.test(line)) sites.push([path.basename(file), line.trim()]);
      }
    }
    /* If this drops to zero the scan has stopped scanning anything. */
    expect(sites.length).toBeGreaterThanOrEqual(3);

    for (const [file, line] of sites) {
      /* Either the segment is hashed, or it is a fixed name with no caller
         input in it (the upstream throttle's `nominatim`). */
      const interpolations = line.match(/\$\{([^}]+)\}/g) ?? [];
      for (const expr of interpolations) {
        const inner = expr.slice(2, -1);
        const safe = inner === 'keyPrefix()'
          || inner.startsWith('hashSegment(')
          || /^(name|domain|bucket)$/.test(inner);
        expect(safe, `${file}: unhashed segment ${expr} in ${line}`).toBe(true);
      }
    }
  });
});

describe('Redis is never a source of truth', () => {
  it('no module under server/redis/ imports the database', () => {
    /* A module that could read the database could also write a derived value
       back into it, which is how a cache becomes a second source of truth. */
    for (const file of filesUnder(path.join(repoRoot, 'server', 'redis'), ['.js'])) {
      expect(read(file), `${path.basename(file)} imports the database`)
        .not.toMatch(/from\s+['"]\.\.\/db(\.js|\/)/);
    }
  });

  it('the set of modules that touch Redis at all is the reviewed one', () => {
    /* Each is a deliberate decision recorded in docs/operations/upstash.md:
       three limiter surfaces, two third-party caches, and two read-only status
       panels. A new one should arrive with a note here rather than by accident —
       this list is the review, not a formality.

       `organizationLimiters.js` is the third limiter surface. It qualifies under
       the same rule as the limiters in app.js and no more: both of its throttles
       tick on abuse rather than on volume — an unauthenticated invitation-link
       lookup and an attempt to join — so the command budget the module header
       reasons about is not at risk, and neither counter is ever read as truth
       about anything. Nothing about organization membership is stored in Redis;
       the source of truth is `organization_members` and
       `organization_join_requests`.

       `integrations/upstash.js` is the Owner Center's read, added with the
       Owner Center. It is read-only in the strongest sense available: it calls
       `redisStatus()` (which owns the allowlist of what an operator may know)
       and `redisPing()`, and nothing else. No key is named, no key is read, and
       there is deliberately no destructive control anywhere on that page — the
       one an operator would actually want, "clear the rate limits", would also
       clear every credential-stuffing counter on a service used by children. */
    const callers = filesUnder(path.join(repoRoot, 'server'), ['.js'])
      .filter(f => !f.includes('.test.') && !f.includes(`${path.sep}redis${path.sep}`))
      .filter(f => /from\s+['"][^'"]*redis\/[a-zA-Z]+\.js['"]/.test(read(f)))
      .map(f => path.relative(repoRoot, f))
      .sort();

    expect(callers).toEqual([
      path.join('server', 'app.js'),                      // limiter stores
      path.join('server', 'integrations', 'upstash.js'),  // Owner Center, read-only
      path.join('server', 'organizationLimiters.js'),     // invite + join throttles
      path.join('server', 'routes', 'adminRoutes.js'),    // status panel, read-only
      path.join('server', 'routes', 'authRoutes.js'),     // login-failure counter
      path.join('server', 'routes', 'geocodeRoutes.js'),  // address cache + throttle
      path.join('server', 'routes', 'weatherRoutes.js'),  // forecast cache
    ]);
  });
});
