import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A conversation open on a phone fills the space between the top bar and the
 * tab bar, with the reply box just above the tab bar.
 *
 * ── What was wrong ──
 *
 * Measured at 375×812 on the rehearsal's data: with a thread open, the reply
 * box sat at 850px — behind the fixed tab bar, below the bottom of the screen.
 * Two causes. The "Messages" heading and its New-message button stayed above
 * the thread, although the thread's own header already carries a back button
 * and the other person's name. And the layout's phone height,
 * `100dvh - 140px`, budgeted for the top of the screen and not for the 57px
 * tab bar at the bottom of it.
 *
 * jsdom does no layout, so — like `mobileNavFit.test.js` — this asserts the
 * stylesheet arithmetic and the class that switches it on. The measurement in
 * the browser is the proof; this is what stops it regressing.
 */
const CSS = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const VIEW = readFileSync(path.join(process.cwd(), 'src/views/Messages.jsx'), 'utf8');

describe('a conversation open on a phone', () => {
  it('marks the page while a thread is open', () => {
    expect(VIEW).toMatch(/messages-page\$\{isMobilePaneVisible \? ' thread-open' : ''\}/);
  });

  it('hides the page heading while a thread is open, on a phone', () => {
    expect(CSS).toMatch(/\.messages-page\.thread-open \.messages-head\s*\{\s*display:\s*none;/);
    /* And the row is styled by class: an inline `display` would outrank it. */
    expect(VIEW).not.toMatch(/className="page-head[^"]*" style=\{\{[^}]*display:/);
  });

  it('sizes the thread to the space between the top bar and the tab bar', () => {
    const rule = CSS.match(/\.messages-page\.thread-open \.messages-layout\s*\{([^}]*)\}/);
    expect(rule, 'the thread-open layout rule exists').toBeTruthy();
    expect(rule[1]).toMatch(/var\(--thread-top\)/);
    expect(rule[1]).toMatch(/var\(--mobilenav-h\)/);
    expect(rule[1]).toMatch(/safe-area-inset-bottom/);
  });
});
