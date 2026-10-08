import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { usePageMeta } from './hooks/usePageMeta';
import { LEGAL_DOCUMENTS } from '../server/legalDocuments.js';

/**
 * What search engines may see (FE-02).
 *
 * The owner asked for the app to be findable. On a platform whose members are
 * children, "findable" means the front door and the published documents: the
 * welcome page, About, the Legal Center, signing in, and the page where anybody
 * can type a certificate code. Never a profile, a club's page, a certificate's
 * result (it names a student), an appeal or an invitation.
 *
 * robots.txt says so to every crawler; `noindex` says it again on the pages
 * that carry a person, because robots.txt is advice and a link from elsewhere
 * can still put a disallowed page in an index.
 */

const ROOT = process.cwd();
const READ = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ORIGIN = 'https://app.wevolunteers.org';

/** Google's reading of robots.txt: the longest matching rule wins, `$` anchors. */
function allowed(robots, urlPath) {
  const rules = robots.split('\n')
    .map(l => l.trim())
    .filter(l => /^(allow|disallow):/i.test(l))
    .map(l => {
      const [kind, ...rest] = l.split(':');
      return { allow: /^allow$/i.test(kind.trim()), pattern: rest.join(':').trim() };
    });
  let best = null;
  for (const r of rules) {
    const anchored = r.pattern.endsWith('$');
    const p = anchored ? r.pattern.slice(0, -1) : r.pattern;
    const matches = anchored ? urlPath === p : urlPath.startsWith(p);
    if (matches && (!best || p.length > best.len || (p.length === best.len && r.allow))) {
      best = { len: p.length, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

describe('robots.txt', () => {
  const robots = READ('public/robots.txt');

  it.each(['/', '/welcome', '/about', '/legal', '/legal/privacy-policy', '/verify', '/login', '/signup'])(
    'lets crawlers read %s', (p) => expect(allowed(robots, p)).toBe(true),
  );

  it.each([
    '/users/@maya', '/users/id/u1', '/organizations/@robotics', '/organizations/invite/abc',
    '/verify/WEV-AAAA-BBBB', '/appeal/token', '/accept-invitation', '/discover', '/api/events',
    '/reset-password', '/certificates/WEV-AAAA-BBBB', '/hours',
  ])('keeps crawlers out of %s', (p) => expect(allowed(robots, p)).toBe(false));

  it('points at the sitemap on the origin nginx serves', () => {
    expect(robots).toMatch(new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
    expect(READ('deploy/nginx/wevolunteers.conf')).toMatch(/server_name app\.wevolunteers\.org;/);
  });

  /* The file named the sitemap and then disallowed it: `Disallow: /` with no
     Allow for /sitemap.xml. Google honours robots.txt when it fetches a
     sitemap, and Search Console reported "Couldn't fetch" on the day it was
     submitted (2026-10-07). */
  it('lets crawlers read the sitemap it points them to', () => {
    expect(allowed(robots, '/sitemap.xml')).toBe(true);
  });
});

describe('sitemap.xml', () => {
  const sitemap = READ('public/sitemap.xml');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

  it('lists only what robots.txt lets a crawler read, on the one origin', () => {
    const robots = READ('public/robots.txt');
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) {
      expect(u.startsWith(`${ORIGIN}/`), u).toBe(true);
      expect(allowed(robots, u.slice(ORIGIN.length)), u).toBe(true);
    }
  });

  it('lists every published legal document', () => {
    for (const doc of LEGAL_DOCUMENTS) expect(urls).toContain(`${ORIGIN}/legal/${doc.slug}`);
  });
});

describe('usePageMeta', () => {
  function Page({ description, noindex }) {
    usePageMeta({ description, noindex });
    return null;
  }

  it('describes the page while it is open, and restores what was there', () => {
    const meta = document.querySelector('meta[name="description"]') || Object.assign(document.createElement('meta'), { name: 'description' });
    document.head.appendChild(meta);
    meta.setAttribute('content', 'Default.');
    const { unmount } = render(<Page description="About WeVolunteer." />);
    expect(meta.getAttribute('content')).toBe('About WeVolunteer.');
    unmount();
    expect(meta.getAttribute('content')).toBe('Default.');
  });

  it('marks a page noindex while it is open, and only then', () => {
    const { unmount } = render(<Page noindex />);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    unmount();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});

describe('the pages that carry a person say noindex themselves', () => {
  it.each([
    'src/views/CertificateVerification.jsx',
    'src/views/Appeal.jsx',
    'src/views/OrganizationInvite.jsx',
    'src/views/OrganizationPublic.jsx',
    'src/views/AcceptInvitation.jsx',
  ])('%s', (file) => {
    expect(READ(file)).toMatch(/usePageMeta\(\{[^}]*noindex/);
  });

  it.each([
    'src/views/Welcome.jsx', 'src/views/AboutUs.jsx', 'src/views/legal/LegalCenter.jsx',
    'src/views/legal/LegalDocument.jsx', 'src/views/Login.jsx', 'src/views/Signup.jsx',
  ])('%s describes itself', (file) => {
    expect(READ(file)).toMatch(/usePageMeta\(\{[^}]*description/);
  });
});
