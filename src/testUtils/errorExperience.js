import { expect } from 'vitest';
import { screen } from '@testing-library/react';

/**
 * Assert that a particular error experience rendered here.
 *
 * ── Why not assert the headline ──
 *
 * The experience rotates between six themes, so its wording is a property of
 * this tab's seed rather than of the routing. Pinning a headline would make the
 * router tests fail roughly five times in six — flaky in exactly the way TD-9
 * was, and for the same reason: an assertion coupled to something the test does
 * not control.
 *
 * `data-error-kind` is stable across rotation, absent from `textContent` (so
 * the no-status-code-in-copy rule is untouched), and is the claim these tests
 * were always really making — not "this headline appeared" but "a 403
 * experience rendered here rather than the dashboard".
 *
 * Shared rather than copied into each router suite: two identical copies drift,
 * and the one that stops being updated is the one still being trusted.
 */
export async function findErrorKind(kind) {
  const el = await screen.findByRole('alert');
  expect(el.dataset.errorKind, `expected the ${kind} experience`).toBe(kind);
  return el;
}
