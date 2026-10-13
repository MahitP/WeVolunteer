import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * The typefaces are served from this origin, never from Google Fonts.
 *
 * `src/index.css` began with an `@import` from fonts.googleapis.com, so every
 * page view — signed in or not, on a population that is mostly minors — sent
 * Google the visitor's IP address and browser, and the page they were on as the
 * referrer's origin. The Cookie and Tracking Notice says that apart from
 * Cloudflare, nothing about how a person uses WeVolunteer reaches anyone unless
 * they switch it on; the Privacy Policy's list of outside services says "Here
 * is all of them" and did not name Google Fonts. Found on 2026-10-12 while
 * drafting Privacy Policy 2.0, and fixed by removing the recipient rather than
 * disclosing it: Bricolage Grotesque and Public Sans are both OFL-licensed, and
 * the Fontsource packages ship the same variable fonts Google served.
 */
const ROOT = process.cwd();
const READ = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const CSS = READ('src/index.css');

/** The family name a Fontsource stylesheet declares. */
function declaredFamily(stylesheet) {
  const css = READ(`node_modules/${stylesheet}`);
  return css.match(/font-family:\s*'([^']+)'/)[1];
}

describe('self-hosted fonts', () => {
  it('nothing the browser loads names a Google Fonts host', () => {
    const tracked = execFileSync('git', ['ls-files', 'src', 'public', 'index.html', 'server/securityHeaders.js', 'deploy/nginx'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(f => f && !/\.test\.[jt]sx?$/.test(f) && /\.(css|html|js|jsx|mjs|conf|json|webmanifest|svg)$/.test(f));
    const offenders = tracked.filter(f => /fonts\.(googleapis|gstatic)\.com/.test(READ(f)));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['@fontsource-variable/bricolage-grotesque/opsz.css', '--font-display'],
    ['@fontsource-variable/public-sans/wght.css', '--font-body'],
  ])('imports %s and puts its family first in %s', (stylesheet, token) => {
    expect(CSS).toContain(`@import '${stylesheet}';`);
    const value = CSS.match(new RegExp(`${token}:\\s*([^;]+);`))[1];
    expect(value.split(',')[0].trim()).toBe(`'${declaredFamily(stylesheet)}'`);
  });

  it('keeps the italic body face the Google request asked for', () => {
    expect(CSS).toContain("@import '@fontsource-variable/public-sans/wght-italic.css';");
  });

  it('keeps the optical-size axis the display face was designed around', () => {
    /* Google served Bricolage with opsz 12..96. Fontsource's index.css is the
       weight axis alone, which renders every size at the default optical
       size; opsz.css carries both axes. */
    const opsz = READ('node_modules/@fontsource-variable/bricolage-grotesque/opsz.css');
    expect(opsz).toMatch(/opsz/);
    expect(opsz).toMatch(/font-weight:\s*200 800/);
  });

  /* Exact, not a caret range: a font update redraws every page, so it should
     arrive as a diff somebody chose, not as a side effect of `npm install`. */
  it('pins the font packages to exact versions', () => {
    const { dependencies } = JSON.parse(READ('package.json'));
    for (const name of ['@fontsource-variable/bricolage-grotesque', '@fontsource-variable/public-sans']) {
      expect(dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
