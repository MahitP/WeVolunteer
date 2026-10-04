import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Nobody is told that school staff run WeVolunteer (final audit, Phase 5).
 *
 * WeVolunteer is operated independently (Posture B). The Privacy Policy names
 * who can see across the platform: "WeVolunteer administrators — the operator,
 * and anyone the operator has given an administrator account to". The product
 * said otherwise in seven places: an organizer "verified by school staff", a
 * pending organizer waiting on "a school administrator", a privacy option
 * reading "Only me and school staff", Welly describing administrators as
 * "School staff members", and two dead ends telling somebody to "contact your
 * school administrator", who has no access to WeVolunteer and cannot help.
 * denialDetail.test.js already holds the refusal page to this; this holds
 * every string a reader can see.
 */

const ROOT = process.cwd();
const SOURCES = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'server', 'routes')),
  path.join(ROOT, 'server', 'services', 'notificationContent.js'),
  path.join(ROOT, 'server', 'email.js'),
].filter(f => /\.(jsx?|mjs)$/.test(f) && !/\.test\./.test(f));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/* Comments explain history and may quote the old wording; only code counts. */
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('who runs WeVolunteer, as the product says it', () => {
  it('never names school staff or a school administrator as the people in charge', () => {
    const offenders = SOURCES
      .map(file => ({ file: path.relative(ROOT, file), text: stripComments(fs.readFileSync(file, 'utf8')) }))
      .filter(({ text }) => /school (staff|administrator)/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
