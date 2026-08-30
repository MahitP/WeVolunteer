import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One `<h1>` per page.
 *
 * ── What was wrong ──
 *
 * The signed-in shell renders `PAGE_META.title` as an `<h1>` in the top bar, and
 * eleven views ALSO opened with their own. Measured in a browser across 24
 * routes: `/`, `/messages`, `/settings`, `/organizations`, `/profile`,
 * `/certificates`, `/portfolio`, `/report-issue`, `/appeals/new`, `/hours`, and
 * the public service-history and certificate pages each had two.
 *
 * A screen reader announces both as the page's title, and "Settings / Settings"
 * or "Profile / Alex Thompson" is not a heading structure anybody can navigate
 * by. It is the one a11y defect on this platform that every screen shared.
 *
 * ── Why the SHELL keeps the h1 and the views gave theirs up ──
 *
 * The content heading is the more natural `h1` semantically, and it is the
 * wrong one to keep here: only some views have one. The top bar's is driven by
 * `PAGE_META`, which `pageTitleCoverage.test.js` proves is complete for every
 * route — so keeping it means every page has exactly one, with no per-view
 * remembering. Demoting the shell instead would have left six routes with none.
 *
 * The demoted headings kept their size through `.page-title` (1.5rem, what `h1`
 * was) or their own existing class, so nothing moved on screen.
 *
 * ── The allowlist is the interesting part ──
 *
 * Some views render OUTSIDE the shell and must keep an `h1`, or those pages
 * would have none at all: the auth screens, the account walls, the legal
 * documents, the public certificate check, the crash screen, and the printed
 * certificate. Listing them is what makes this rule enforceable rather than a
 * blanket ban that would be wrong half the time — and a new file has to be
 * argued onto the list rather than added by accident.
 */

const ROOT = process.cwd();

/**
 * Views rendered WITHOUT the application shell, which therefore own their page's
 * only `<h1>`.
 *
 * Adding to this list is a claim that the file renders outside the shell. If it
 * does not, the page gets two `h1`s again and this guard will not catch it —
 * so the claim is the thing to check when reviewing a change here.
 */
/*
 * NOTE ON A MISTAKE THIS LIST ALREADY MADE.
 *
 * `views/PublicProfile.jsx` was on here originally, on the strength of a browser
 * probe that showed `/users/@someone` with a single `h1`. The probe was wrong:
 * that username did not exist in the database being measured, so the route was
 * rendering its not-found state, which has no heading of its own. The real page
 * renders inside the shell and had two.
 *
 * Which is the point of the note at the top: an entry here is a CLAIM that a
 * file renders without the shell, and the guard cannot check the claim. Measure
 * a route that actually has data before adding one.
 */
const STANDALONE = new Set([
  /* Authentication and account gates — rendered before or instead of the shell. */
  'views/Login.jsx',
  'views/Signup.jsx',
  'views/Welcome.jsx',
  'views/ResetPassword.jsx',
  'views/OAuthCallback.jsx',
  'views/Appeal.jsx',
  'components/account/SuspendedWall.jsx',
  'components/account/VerifyEmailWall.jsx',
  'components/auth/TwoFactorRequiredWall.jsx',

  /* Legal documents, which are their own full-page reading surface. */
  'views/AboutUs.jsx',
  'views/legal/LegalCenter.jsx',
  'views/legal/LegalDocument.jsx',
  /* The two organizer agreements are NOT here any more, and that is the point.
     They were allowlisted as rendering outside the shell, and they do not: both
     are in APP_ROUTES and nothing else mounts them, so the shell's `h1` was
     already on screen and each view added a second one saying the same words.
     Measured in a browser, /organizer-agreement announced "Organizer Agreement,
     heading level 1" twice for every role — the exact "Settings / Settings"
     defect this file's header describes, surviving because an allowlist entry
     asserted something untrue. The runtime check in a11y/sweep.aria.spec.js is
     what caught it. */

  /* Public, signed-out pages. */
  'views/CertificateVerification.jsx',

  /* The crash experience replaces the whole tree, including the shell. */
  'views/ErrorExperience/ErrorExperience.jsx',
  'views/ErrorExperience/ErrorGallery.jsx',

  /**
   * Printed and modal certificates. `printIsolation.test.js` covers the rule
   * that print hides the shell — so on paper this heading is the only one, and
   * demoting it would leave the printed document with no heading at all.
   */
  'components/CertificateModal.jsx',
  'views/VolunteerDashboard.jsx',

  /* No importers — flagged for separate cleanup, not rendered anywhere. */
  'components/EventHero.jsx',
]);

/** Every `.jsx` under src/, excluding tests. */
function componentFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.jsx') || /\.test\./.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return found;
}

const rel = (f) => path.relative(path.join(ROOT, 'src'), f).split(path.sep).join('/');

describe('the shell owns the page heading', () => {
  const files = componentFiles();

  it('finds components to check, so this cannot pass by scanning nothing', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('is the only place App.jsx renders an h1', () => {
    /* If the top bar ever stops rendering one, every signed-in page loses its
       heading entirely — and every other case here assumes it is there. */
    const app = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
    const h1s = app.match(/<h1[\s>]/g) || [];
    expect(h1s).toHaveLength(1);
    expect(app).toMatch(/<h1 className="topbar-title truncate">\{meta\.title\}<\/h1>/);
  });

  it('no shell-rendered view declares its own h1', () => {
    const offenders = files
      .filter((f) => rel(f) !== 'App.jsx')
      .filter((f) => !STANDALONE.has(rel(f)))
      .filter((f) => /<h1[\s>]/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);

    expect(
      offenders,
      'These render inside the shell, which already provides the page\'s <h1> from '
      + 'PAGE_META — so each of these pages now has two, and a screen reader '
      + 'announces both as the title.\n'
      + 'Use <h2 className="page-title"> to keep the same appearance, or add the '
      + 'file to STANDALONE if it genuinely renders without the shell.\n\n'
      + offenders.join('\n')
    ).toEqual([]);
  });

  it('keeps the demoted headings looking like page titles', () => {
    /* The demotion must not have shrunk anything: `h1` is 1.5rem and `h2` is
       1.0625rem, so the replacement class has to restore the difference. */
    const css = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
    expect(css).toMatch(/\.page-title \{ font-size: 1\.5rem; \}/);
    /* `.page-head` styled its heading by tag, so the selector had to follow. */
    expect(css).toMatch(/\.page-head h1, \.page-head h2 \{ font-size: 1\.5rem; \}/);
  });

  it('does not let the allowlist quietly grow to cover everything', () => {
    /**
     * A guard whose exceptions outnumber its subjects has stopped being a
     * guard. This is a smell test rather than a limit anybody should tune: if
     * it fails, the question is whether the shell/standalone split is still
     * real, not whether the number should be raised.
     */
    expect(STANDALONE.size).toBeLessThan(files.length / 2);
  });
});
