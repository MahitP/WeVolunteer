/**
 * Global setup for tests that run in the jsdom environment.
 *
 * `cleanup` after each test is not optional: React Testing Library mounts into
 * a container appended to document.body, and without teardown those containers
 * accumulate across tests in the same file. Queries like getByRole then match
 * elements left behind by an earlier test, which produces failures that read as
 * "duplicate element" in a test that only rendered one.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

/**
 * No source comment may reach the screen.
 *
 * ── The incident ──
 *
 * `AdminDashboard.jsx` carried a thirteen-line block comment explaining why the
 * reports queue was moved above the analytics. It was written as a bare
 * `/* … *\/` block directly in JSX CHILDREN position, without the `{}` wrapper
 * JSX requires. That is not a syntax error — in children position it is TEXT.
 *
 * So every administrator and owner opened the Moderation Center, the most
 * important administrative page on the platform, and read a paragraph of
 * engineering prose about 720px viewports sitting above the safety queue.
 *
 * It survived the build, the linter, and 3,400 tests. It was found by looking at
 * a screenshot.
 *
 * ── Why the check lives HERE ──
 *
 * A static scan of the source cannot tell JSX children position from an ordinary
 * JS comment without parsing, and the heuristics that approximate it produce
 * dozens of false positives on this codebase — which is a guard nobody can keep
 * green, and therefore a guard somebody switches off.
 *
 * Rendered output has no such ambiguity: a comment that leaks IS text, and text
 * is precisely what jsdom can be asked about. Putting it in the global teardown
 * means every render test in the client suite checks for it at no extra cost,
 * with no new file to maintain and no view anybody has to remember to cover.
 *
 * `──` is checked alongside the markers because this codebase's comment banners
 * are drawn with it, and a leak beginning mid-comment would carry no `/*`.
 */
const COMMENT_MARKERS = ['/*', '*/', '──'];

afterEach(() => {
  const text = document.body.textContent || '';
  const leaked = COMMENT_MARKERS.filter(m => text.includes(m));

  /* Read before `cleanup` empties the container, asserted after it — so a
     failure here cannot leave mounted DOM behind for the next test to trip on. */
  cleanup();

  expect(
    leaked,
    'A source comment reached the rendered output. In JSX children position a '
    + 'block comment is TEXT, not a comment — it needs to be wrapped in braces. '
    + `Markers found: ${leaked.join(' ')}`,
  ).toEqual([]);
});

/**
 * `ResizeObserver`, which jsdom does not implement.
 *
 * The mobile navigation measures its own scroll geometry to decide whether to
 * show the "there is more this way" fade, and observes the strip so that a
 * rotation or an opening keyboard re-measures. jsdom has no layout engine and
 * no `ResizeObserver`, so without this every test that mounts the app shell
 * throws `ResizeObserver is not defined` from an effect.
 *
 * A no-op is the honest stub rather than a lie: jsdom reports every element as
 * zero-sized, so a faithful implementation would fire a resize that means
 * nothing. What the component needs from the test environment is only that
 * constructing one does not throw; the geometry it would report is not
 * something jsdom can be asked about, and the fade is a visual affordance
 * rather than behaviour a test should assert through a fake layout.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
