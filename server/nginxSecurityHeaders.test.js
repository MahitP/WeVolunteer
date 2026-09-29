/**
 * The security headers on documents nginx serves itself.
 *
 * ── The failure this forbids ──
 *
 * helmet's Content-Security-Policy, HSTS and framing rules were applied by
 * Express, and in production Express never serves the SPA page — nginx does,
 * from dist/. The page therefore shipped with none of them, while the JSON beside
 * it carried all of them. A CSP protects a document; on JSON it does nothing. The
 * nginx config even said CSP was "deliberately NOT set here" because the
 * application sends its own — true of every response except the one that needed
 * it. Observed on the live site on 2026-09-13.
 *
 * ── What is asserted, and what cannot be from here ──
 *
 * The rendered snippet must equal what helmet itself sends, so the policy has one
 * source. Every location nginx answers must include it, because nginx does not
 * inherit add_header into a location that declares its own. `nginx -t` is not
 * run: nginx is not part of this repository's toolchain, so the config is checked
 * structurally, and provision.sh runs `nginx -t` before any reload on the host.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  renderSnippet, helmetDocumentHeaders, SNIPPET_PATH, DOCUMENT_HEADERS,
} from '../bin/nginx-security-headers.mjs';
import { DOCUMENT_REFERRER_POLICY } from './securityHeaders.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONF = readFileSync(path.join(ROOT, 'deploy/nginx/wevolunteers.conf'), 'utf8');
const INCLUDE = 'include /etc/nginx/snippets/wevolunteers-security-headers.conf;';

/** Comments removed, so a sentence ABOUT add_header is not read as one. */
const code = (text) => text.split('\n').map(l => l.replace(/#.*$/, '')).join('\n');

/** The HTTPS server block, and each `location … { … }` inside it (no nesting in this file). */
function httpsServer() {
  const body = code(CONF);
  const start = body.indexOf('listen 443');
  expect(start, 'no HTTPS server block found').toBeGreaterThan(-1);
  return body.slice(start);
}
function locations(serverBody) {
  const out = [];
  const re = /location\s+([^{]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(serverBody))) out.push({ match: m[1].trim(), body: m[2] });
  return out;
}

describe('the rendered header snippet', () => {
  it('is exactly what the source renders — regenerate it, never edit it', async () => {
    expect(readFileSync(SNIPPET_PATH, 'utf8')).toBe(await renderSnippet());
  });

  it('carries the Content-Security-Policy and HSTS that Express sends, verbatim', async () => {
    const helmet = await helmetDocumentHeaders();
    const snippet = readFileSync(SNIPPET_PATH, 'utf8');
    for (const name of ['content-security-policy', 'strict-transport-security', 'x-frame-options']) {
      expect(snippet).toContain(`"${helmet[name]}" always;`);
    }
    expect(helmet['content-security-policy']).toMatch(/script-src 'self'/);
    expect(helmet['content-security-policy']).not.toMatch(/unsafe-inline/);
    expect(DOCUMENT_HEADERS).toContain('content-security-policy');
  });

  it('keeps a Referrer-Policy on documents that does not null the Origin of same-origin writes', () => {
    /* no-referrer on a PAGE makes a standards-following browser send
       `Origin: null` on same-origin POSTs, which the CORS layer refuses. */
    const snippet = readFileSync(SNIPPET_PATH, 'utf8');
    expect(DOCUMENT_REFERRER_POLICY).not.toBe('no-referrer');
    expect(snippet).toContain(`add_header Referrer-Policy "${DOCUMENT_REFERRER_POLICY}" always;`);
    expect(snippet.match(/Referrer-Policy/g)).toHaveLength(1);
  });

  it('says X-Frame-Options DENY, matching frame-ancestors none', async () => {
    const helmet = await helmetDocumentHeaders();
    expect(helmet['x-frame-options']).toBe('DENY');
    expect(helmet['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('the nginx site config', () => {
  it('includes the snippet in every location nginx answers without Express', () => {
    const blocks = locations(httpsServer());
    const byMatch = Object.fromEntries(blocks.map(b => [b.match, b.body]));
    for (const documentLocation of ['/', '= /index.html', '/assets/', '/uploads/']) {
      expect(byMatch[documentLocation], `location ${documentLocation} is missing`).toBeDefined();
      expect(byMatch[documentLocation], `location ${documentLocation}`).toContain(INCLUDE);
    }
  });

  it('never leaves a static location with its own add_header and no snippet', () => {
    /* A location that declares any add_header inherits NONE from outside it.
       Every such location must either proxy to Express (which sends helmet's
       headers) or include the snippet. */
    for (const { match, body } of locations(httpsServer())) {
      if (!/add_header/.test(body)) continue;
      const proxied = /proxy_pass\s+http:\/\/wevolunteer_app/.test(body);
      expect(proxied || body.includes(INCLUDE), `location ${match}`).toBe(true);
    }
  });

  it('sets no header at server level, where proxied locations would duplicate helmet', () => {
    const server = httpsServer();
    const outsideLocations = server.replace(/location\s+[^{]+\{[^}]*\}/g, '');
    expect(outsideLocations).not.toMatch(/add_header/);
  });

  it('never repeats a directive Ubuntu\'s nginx.conf already sets at http level', () => {
    /* `gzip on;` is set by /etc/nginx/nginx.conf on Ubuntu, and a second copy
       at http level makes `nginx -t` fail. Production was hand-patched on
       2026-09-12 to remove it; the repository kept it, so provisioning would
       have installed a config that cannot load. */
    expect(code(CONF)).not.toMatch(/^\s*gzip\s+on\s*;/m);
  });

  it('never marks an error response as cacheable for a year', () => {
    /* `add_header … always` attaches the header to 404s and 403s too, and
       Cloudflare cached a 403 for an uploads URL for that reason. */
    expect(code(CONF)).not.toMatch(/add_header\s+Cache-Control\s+"public[^"]*immutable"\s+always/);
  });

  it('discloses Cloudflare wherever the beacon is allowed', () => {
    /**
     * This test used to forbid `static.cloudflareinsights.com` outright. The
     * owner decided on 2026-09-29 to keep Cloudflare Web Analytics, so it now
     * enforces the obligation that comes with allowing it instead of the
     * prohibition.
     *
     * The rule it holds: **if the CSP lets Cloudflare receive data, the Cookie
     * Notice must say so.** A tracker nobody disclosed is the actual harm; the
     * CSP line is only how it becomes possible. Either both change or neither
     * does — including in the removal direction, because a notice describing a
     * beacon that no longer runs is wrong in the other direction.
     *
     * Two hosts, not one: the script LOADS from static.cloudflareinsights.com
     * and REPORTS to cloudflareinsights.com. Allowing only the first leaves the
     * script running and every report refused, which collects nothing and still
     * logs an error.
     */
    /* The HEADERS snippet, not CONF — CONF is deploy/nginx/wevolunteers.conf,
       the site config, which contains no CSP at all. The first version of this
       test read CONF, matched nothing, and passed vacuously while the notice
       was still silent about Cloudflare. A guard that cannot fail is worse than
       no guard, because it is counted. */
    const conf = code(readFileSync(
      path.join(ROOT, 'deploy/nginx/wevolunteers-security-headers.conf'), 'utf8',
    ));
    const notice = readFileSync(
      path.join(ROOT, 'docs/legal/policies/05-cookie-and-tracking-notice.md'), 'utf8',
    );

    const loads = /script-src[^;"]*static\.cloudflareinsights\.com/.test(conf);
    const reports = /connect-src[^;"]*[^.]cloudflareinsights\.com/.test(conf);

    expect(
      loads === reports,
      'the beacon is half-allowed. It loads from static.cloudflareinsights.com '
      + 'and reports to cloudflareinsights.com; allowing one without the other '
      + 'means it runs and collects nothing while still logging a CSP error.',
    ).toBe(true);

    if (loads) {
      expect(
        /cloudflare/i.test(notice),
        'the CSP allows the Cloudflare beacon but the Cookie and Tracking Notice '
        + 'does not mention Cloudflare. That notice tells readers exactly which '
        + 'third parties receive anything, and it is read by students and their '
        + 'guardians. Disclose it there, or remove the CSP entries.',
      ).toBe(true);
    }
  });

  it('is provisioned: the snippet is installed before nginx -t', () => {
    const provision = code(readFileSync(path.join(ROOT, 'deploy/provision.sh'), 'utf8'));
    const install = provision.indexOf('/etc/nginx/snippets/wevolunteers-security-headers.conf');
    const test = provision.indexOf('nginx -t');
    expect(install).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(install);
  });
});
