#!/usr/bin/env node
/**
 * Turns the committed baseline into the measured rows of the audit document.
 *
 * Deliberately NOT the whole document. Severity, who is affected, what the fix
 * is, and whether something was human-verified are judgements, and a generator
 * that emitted them would emit confident guesses. This prints the measured
 * columns; a person writes the rest.
 *
 * It also refuses to run while any row still carries the placeholder finding id,
 * because a baseline row nobody has explained is a defect filed under "later".
 *
 * `npm run a11y:report` referenced this file before it existed — the script was
 * declared in package.json and in the engineering guide while the module was
 * missing, so the command failed with MODULE_NOT_FOUND. Caught by a review that
 * checked whether the report output had any consumer at all.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'a11y/A11Y_BASELINE.json');

if (!fs.existsSync(FILE)) {
  console.error(`No baseline at ${FILE}. Run: A11Y_UPDATE_BASELINE=1 npm run a11y`);
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const rows = [];
for (const [key, rules] of Object.entries(baseline)) {
  const [route, role] = key.split('::');
  for (const [rule, entry] of Object.entries(rules)) {
    rows.push({ finding: entry.finding, rule, route, role, count: entry.count });
  }
}

if (rows.length === 0) {
  console.log('The accessibility baseline is empty: axe reports no accepted violations.');
  console.log('Nothing to tabulate — that is the result, not a missing file.');
  process.exit(0);
}

const stale = rows.filter(r => !r.finding || r.finding === 'A-00');
if (stale.length) {
  console.error(`${stale.length} baseline row(s) still carry the placeholder id A-00.`);
  console.error('Give each one a real finding id in docs/audits/ before committing.');
  process.exit(1);
}

rows.sort((a, b) => a.finding.localeCompare(b.finding) || a.route.localeCompare(b.route));

console.log('| Finding | axe rule | Route | Role | Instances |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(`| ${r.finding} | \`${r.rule}\` | \`${r.route}\` | ${r.role} | ${r.count} |`);
}
console.log('');
console.log(`${rows.length} accepted violation row(s) across ${new Set(rows.map(r => r.route)).size} route(s).`);
