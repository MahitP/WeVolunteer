/**
 * What nginx writes to its access log.
 *
 * ── The failure this forbids ──
 *
 * Ubuntu's nginx.conf logs every request in the `combined` format, whose
 * `$request` is the request line with its query string, and whose
 * `$http_referer` is the page the request came from with ITS query string. The
 * product puts secrets and positions in query strings:
 *
 *   /reset-password?token=…      a reset token IS the account until spent
 *   /accept-invitation?token=…   an administrator invitation
 *   /appeal?token=…              a suspended student's appeal
 *   /api/events?lat=…&lng=…      a minor's coarse position, "Nearest to me"
 *   /api/geocode?q=…&lat=…       the same, biasing a place search
 *
 * On 2026-10-07 the production access logs held eleven reset links with their
 * tokens (all expired: tokens live one hour), and the Privacy Policy said a
 * student's coordinates are "never stored — not in our database, not in a
 * log". The application's own request logging already drops query strings
 * (server/app.js, "The Express PATTERN, never `req.originalUrl`"); nginx was
 * the one place that kept them.
 *
 * ── What is asserted ──
 *
 * Structurally, as nginxSecurityHeaders.test.js does: nginx is not part of this
 * repository's toolchain, and provision.sh runs `nginx -t` before any reload.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONF = readFileSync(path.join(ROOT, 'deploy/nginx/wevolunteers.conf'), 'utf8');

/** Comments removed, so a sentence ABOUT a directive is not read as one. */
const code = (text) => text.split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
const BODY = code(CONF);

/** Every `server { … }` block, by brace depth (locations nest one level). */
function serverBlocks() {
  const out = [];
  /* matchAll, not a `re.exec` loop: asyncShapes.test.js counts `exec(` in test
     files as an unawaited database call. */
  for (const m of BODY.matchAll(/(^|\n)\s*server\s*\{/g)) {
    let depth = 0;
    for (let i = BODY.indexOf('{', m.index); i < BODY.length; i += 1) {
      if (BODY[i] === '{') depth += 1;
      if (BODY[i] === '}' && --depth === 0) { out.push(BODY.slice(m.index, i + 1)); break; }
    }
  }
  return out;
}

/** The format named on a server's own access_log line (locations excluded). */
function serverAccessLogFormat(server) {
  const outsideLocations = server.replace(/location\s+[^{]+\{[^}]*\}/g, '');
  const line = outsideLocations.match(/^\s*access_log\s+([^;]+);/m);
  return line ? line[1].trim().split(/\s+/) : null;
}

/** The regex and capture a `map $source $target { "~…" $capture; }` block uses. */
function mapRegex(source, target) {
  const block = BODY.match(new RegExp(`map\\s+\\$${source}\\s+\\$${target}\\s*\\{([^}]*)\\}`));
  expect(block, `map $${source} $${target} is missing`).not.toBeNull();
  const entry = block[1].match(/"~([^"]+)"\s+\$(\w+)\s*;/);
  expect(entry, `map $${target} has no regex entry`).not.toBeNull();
  /* nginx uses PCRE; `(?<name>…)` is the same in JavaScript. */
  return { re: new RegExp(entry[1]), capture: entry[2], body: block[1] };
}

function applyMap({ re, capture }, value) {
  const m = value.match(re);
  return m ? m.groups[capture] : null;
}

describe('the nginx access log', () => {
  it('is written by every server block in a format of our own', () => {
    const servers = serverBlocks();
    expect(servers.length).toBeGreaterThanOrEqual(2);
    for (const server of servers) {
      const name = server.match(/server_name\s+([^;]+);/)?.[1];
      expect(serverAccessLogFormat(server), `server ${name} inherits Ubuntu's combined format`)
        .toEqual(['/var/log/nginx/access.log', 'wevolunteer_noquery']);
    }
  });

  it('defines that format without anything that carries a query string', () => {
    const format = BODY.match(/log_format\s+wevolunteer_noquery\s+([^;]+);/);
    expect(format, 'log_format wevolunteer_noquery is missing').not.toBeNull();
    for (const variable of ['$request', '$request_uri', '$args', '$query_string', '$http_referer', '$is_args', '$uri']) {
      expect(format[1], variable).not.toMatch(new RegExp(`\\${variable}(?![\\w])`));
    }
    expect(format[1]).toContain('$wev_logged_path');
    expect(format[1]).toContain('$wev_logged_referer');
  });

  it.each([
    ['/reset-password?token=abc123', '/reset-password'],
    ['/accept-invitation?token=abc123', '/accept-invitation'],
    ['/appeal?token=abc123', '/appeal'],
    ['/api/events?sort=distance&lat=40.3&lng=-74.6', '/api/events'],
    ['/api/geocode?q=library&lat=40.3&lon=-74.6', '/api/geocode'],
    ['/api/events', '/api/events'],
    ['/', '/'],
  ])('logs %s as %s', (requested, logged) => {
    expect(applyMap(mapRegex('request_uri', 'wev_logged_path'), requested)).toBe(logged);
  });

  it.each([
    ['https://app.wevolunteers.org/reset-password?token=abc123', 'https://app.wevolunteers.org/reset-password'],
    ['https://app.wevolunteers.org/discover', 'https://app.wevolunteers.org/discover'],
  ])('logs the referer %s as %s', (sent, logged) => {
    expect(applyMap(mapRegex('http_referer', 'wev_logged_referer'), sent)).toBe(logged);
  });

  it('logs a missing referer as "-", as combined did', () => {
    expect(mapRegex('http_referer', 'wev_logged_referer').body).toMatch(/^\s*""\s+"-"\s*;/m);
  });
});
