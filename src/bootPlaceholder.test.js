import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Something on screen before the app's JavaScript runs (W2, FX-52).
 *
 * `index.html` held an empty `#root`, so until the bundle had downloaded and
 * run the page was blank — on a slow phone connection, long enough to read as
 * "the site is broken", which is what the owner asked to have checked. React
 * replaces `#root`'s contents when it mounts, so a placeholder there costs
 * nothing once the app is up.
 *
 * Styled from a same-origin stylesheet, never inline: the production
 * Content-Security-Policy is `style-src 'self' https://fonts.googleapis.com`,
 * which blocks both `<style>` elements and `style=""` attributes.
 */
const HTML = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

describe('the pre-mount placeholder', () => {
  it('puts the brand in #root before the app runs', () => {
    const root = HTML.match(/<div id="root">([\s\S]*?)<\/div>\s*(?:<noscript|<script)/);
    expect(root, '#root is followed by the noscript note or the module script').toBeTruthy();
    expect(root[1]).toMatch(/class="boot"/);
    expect(root[1]).toMatch(/WeVolunteer/);
  });

  it('is styled by a linked stylesheet that exists', () => {
    expect(HTML).toMatch(/<link rel="stylesheet" href="\/boot\.css"/);
    expect(existsSync(path.join(process.cwd(), 'public/boot.css'))).toBe(true);
  });

  it('uses no inline style the CSP would block', () => {
    expect(HTML).not.toMatch(/<style[\s>]/);
    expect(HTML).not.toMatch(/\sstyle="/);
  });
});
