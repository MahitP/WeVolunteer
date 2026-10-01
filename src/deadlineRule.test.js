import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deadlineAfterFirstShift } from './eventRules';

/**
 * The application deadline may be ON or before the first shift's start — the
 * server's rule. The create form had its own copy, written `>=`, so it refused
 * a deadline equal to the start that the server, and Welly (which runs the
 * server's validator), both accept (A5). One rule, re-exported, never copied:
 * the arrangement `src/eventRules.js` already describes.
 */
describe('the application-deadline rule', () => {
  const start = Date.parse('2026-10-10T13:00:00.000Z');

  it('allows a deadline equal to the first shift start', () => {
    expect(deadlineAfterFirstShift(start, start)).toBe(false);
  });

  it('refuses a deadline after it', () => {
    expect(deadlineAfterFirstShift(start + 60_000, start)).toBe(true);
  });

  it('is the rule the create form uses, not a copy of it', () => {
    const form = readFileSync(path.join(process.cwd(), 'src/views/CreateEvent.jsx'), 'utf8');
    expect(form).toMatch(/deadlineAfterFirstShift\(/);
    expect(form).not.toMatch(/new Date\(applicationDeadline\) >= first/);
  });
});
