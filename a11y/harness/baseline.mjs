import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '../A11Y_BASELINE.json');

export function load() {
  if (!fs.existsSync(FILE)) return {};
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

export function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * The ratchet is one-way: counts may fall freely, and may only rise through an
 * explicit reviewed edit to the committed baseline file.
 *
 * Two rules, and the second is the one that is easy to leave out. A NEW rule
 * firing is a regression, and an EXISTING rule firing MORE OFTEN is also a
 * regression. Without the second, somebody adds nine more unlabelled buttons to
 * a page that already had one and the run stays green — which is worse than
 * having no baseline at all, because it reads as proof.
 *
 * Every entry must name the audit finding that explains it, or this throws. An
 * unexplained accepted violation is how a baseline becomes a list nobody can
 * act on.
 */
export function compare(baseline, found) {
  const regressions = [];
  const fixed = [];
  const unchanged = [];

  for (const [key, rules] of Object.entries(baseline)) {
    for (const [rule, entry] of Object.entries(rules)) {
      if (!entry || typeof entry.finding !== 'string' || entry.finding === '') {
        throw new Error(
          `baseline entry ${key} / ${rule} has no audit finding id. `
          + 'Every accepted violation must point at the row that explains it.'
        );
      }
    }
  }

  const keys = new Set([...Object.keys(baseline), ...Object.keys(found)]);
  for (const key of keys) {
    const was = baseline[key] || {};
    const now = found[key] || {};
    for (const rule of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const before = was[rule]?.count ?? 0;
      const after = now[rule] ?? 0;
      if (after > before) regressions.push({ key, rule, was: before, now: after });
      else if (after < before) fixed.push({ key, rule, was: before, now: after });
      else unchanged.push({ key, rule, count: after });
    }
  }
  return { regressions, fixed, unchanged };
}
