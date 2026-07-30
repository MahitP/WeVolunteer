import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Keeps debug logging out of the notification dispatch path.
 *
 * `notificationService.dispatch` shipped with
 * `console.log('[DEBUG] dispatch successful for event …, userId …')` on EVERY
 * notification. Two problems, and the second is the one that matters: at district
 * scale it is a line per notification per user in the process log, and it writes
 * a user id to stdout, where logs are aggregated and retained by infrastructure
 * that was never scoped to hold identifiers for minors.
 *
 * A source assertion rather than a behavioural one, deliberately. The failure mode
 * is a `console.log` added back during debugging and forgotten — which no
 * behavioural test can see, because the feature still works perfectly. This is the
 * cheapest thing that actually catches it in review.
 */
describe('notification dispatch logging', () => {
  const source = readFileSync(path.join(here, 'services/notificationService.js'), 'utf8');

  it('contains no [DEBUG] markers', () => {
    expect(source).not.toContain('[DEBUG]');
  });

  it('does not console.log on the dispatch path', () => {
    // console.error in a catch is legitimate — a failure nobody sees is worse.
    // An unconditional console.log on the success path is not.
    const logCalls = source.match(/console\.log\(/g) || [];
    expect(logCalls).toHaveLength(0);
  });

  it('does not write a user id to stdout', () => {
    // Catches the specific shape that shipped: interpolating userId into a log
    // line, whatever the surrounding wording.
    const lines = source.split('\n');
    const offenders = lines.filter(l =>
      /console\.(log|info|debug)/.test(l) && /userId|user_id/.test(l)
    );
    expect(offenders).toEqual([]);
  });
});
