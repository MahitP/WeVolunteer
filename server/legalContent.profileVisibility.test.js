import { describe, it, expect } from 'vitest';
import { policyContent } from './legalContent.js';
import { PUBLIC_BASELINE_FIELDS } from './profileSerializer.js';
import { DEFAULT_SERVICE_VISIBILITY } from './serviceVisibility.js';

/**
 * What the Youth Safety Guidelines tell a guardian about a student's profile,
 * held against what the serializer actually emits.
 *
 * The parents' section said "Their profile is private by default. Nobody sees
 * it unless the student changed that." A profile is findable by name, so the
 * second sentence was false at every setting — and by default the student's
 * hours and certificates were visible to every member as well. Under Posture B
 * a published sentence like that is a promise the operator answers for
 * personally (docs/legal/15-PROFILE-VISIBILITY-DEFAULTS.md).
 *
 * So the guard is two-sided. The prose must not claim invisibility, and each
 * thing it says stays hidden must actually be absent from the baseline the
 * serializer gives another member. A later change that put `location` back on
 * the baseline, or made service records public again by default, fails here
 * rather than quietly making the guidelines untrue a second time.
 */

const PARENTS_HEADING = '## For parents and guardians';

function parentsSection() {
  const body = policyContent('youth-safety-guidelines');
  const start = body.indexOf(PARENTS_HEADING);
  expect(start, 'the parents heading has moved — update this test, do not delete it').toBeGreaterThan(-1);
  const rest = body.slice(start + PARENTS_HEADING.length);
  const end = rest.search(/\n#{2} /);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
}

describe('the Youth Safety Guidelines, on who can see a student', () => {
  it('no longer tell a guardian that nobody sees the profile', () => {
    expect(parentsSection()).not.toMatch(/nobody sees it/i);
  });

  it('say that adult organizers are among the people who can see it', () => {
    expect(parentsSection()).toMatch(/organizers who have signed our Organizer Agreement/);
  });

  it('name the parts that stay hidden until the student shows them', () => {
    const section = parentsSection();
    const hidden = section.match(/Their ([^.]*?) stay \*\*hidden until the student chooses to show them\*\*/);
    expect(hidden, 'the "stay hidden" sentence is missing or reworded').toBeTruthy();
    for (const thing of ['school', 'grade', 'bio', 'location', 'interests', 'skills', 'volunteer hours', 'certificates']) {
      expect(hidden[1], `the guidelines no longer say ${thing} is hidden`).toContain(thing);
    }
  });
});

describe('and the code keeps those words true', () => {
  it('does not put location, interests or skills on the always-visible baseline', () => {
    for (const field of ['location', 'hobbies', 'skills', 'bio', 'school', 'grade']) {
      expect(PUBLIC_BASELINE_FIELDS, `${field} is on the baseline, which the guidelines say is hidden`)
        .not.toContain(field);
    }
  });

  it('starts every service record private', () => {
    expect(DEFAULT_SERVICE_VISIBILITY).toBe('private');
  });
});
