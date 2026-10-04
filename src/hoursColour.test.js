import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A volunteer's hours are always the hours colour (owner ruling 24, 2026-10-04).
 *
 * The figure was coloured by progress to the 25-hour target: red under a
 * third, amber under the target, green after. So a student's first sight of
 * their own record, on the day they joined, was a red "0 hrs" — a mark of
 * failure on somebody who had not started. The meter beside it shows the
 * progress; the number is just the number, in the colour hours are everywhere.
 */
const read = file => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('the hours figure on a volunteer\'s own pages', () => {
  for (const file of ['src/views/VolunteerDashboard.jsx', 'src/views/VolunteerProfile.jsx']) {
    it(`is never coloured by progress in ${file}`, () => {
      const src = read(file);
      expect(src).not.toMatch(/stat-value \$\{progressTone\}/);
      expect(src).toMatch(/className="stat-value accent"/);
    });
  }
});
