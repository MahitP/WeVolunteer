import { describe, it, expect } from 'vitest';
import { policyContent } from './legalContent.js';

/**
 * The guardian-consent section says what it means and not more.
 *
 * ── The ambiguity this exists to prevent ──
 *
 * The section opens "There is no parent or guardian consent step on
 * WeVolunteer, and we are not building one." followed by "Specifically:" and
 * four bullets. One of them read:
 *
 *   "We do not send a confirmation link to anybody, and nothing waits for an
 *    approval."
 *
 * Scoped by the lead-in it was accurate. Read alone — which is how a bullet is
 * read, and how a bullet gets quoted — it made two claims about the whole
 * application, and both are false:
 *
 *   - This platform sends links. Email verification, password reset, the
 *     administrator invitation flow, and an organization's invitation links all
 *     send one.
 *   - This platform has approval workflows. An organizer approves event
 *     applications, and a manager approves organization join requests.
 *
 * A privacy notice that overstates a commitment is not a safer privacy notice.
 * It is one whose next reader finds a contradiction and has no way to tell which
 * half is true.
 *
 * ── Why the assertion is on the WORDS ──
 *
 * There is no schema fact to check here, and that is the point: this is a
 * failure mode of PROSE. The check is that the guardian bullets each name a
 * guardian, so a future edit cannot widen one back into a claim about the
 * application by dropping four words.
 *
 * Read through `policyContent`, which returns the published half — the same
 * text a reader is served, and the half the pinned hash covers. Asserting
 * against the raw file would also match the specification block above the
 * `## Draft` marker, which is drafting notes rather than policy.
 */

const GUARDIAN_HEADING = '### What we do not do, and want you to know before you go looking for it';

/** The four bullets under the "Specifically:" lead-in. */
function guardianBullets() {
  const body = policyContent('privacy-policy');
  const start = body.indexOf(GUARDIAN_HEADING);
  expect(
    start,
    'the guardian section heading has changed — if that is deliberate, update this test '
    + 'rather than deleting it: the ambiguity it guards is a property of the prose',
  ).toBeGreaterThan(-1);

  /* To the next heading of any level, so the slice cannot run on into the age
     section and pick up bullets that are not about guardians. */
  const rest = body.slice(start + GUARDIAN_HEADING.length);
  const end = rest.search(/\n#{2,3} /);
  const section = end === -1 ? rest : rest.slice(0, end);

  /* Bullets can wrap, so a line starting `- ` opens one and the following
     indented lines continue it. */
  const bullets = [];
  for (const line of section.split('\n')) {
    if (/^- /.test(line)) bullets.push(line.replace(/^- /, '').trim());
    else if (bullets.length && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return bullets;
}

describe('the guardian-consent bullets', () => {
  it('are there to be checked, so this cannot pass by finding none', () => {
    expect(guardianBullets().length).toBeGreaterThanOrEqual(4);
  });

  /**
   * Each bullet names a guardian.
   *
   * That is the whole rule, and it is what makes every one of them survive
   * being read on its own: "we do not ask for a guardian's email address" is a
   * statement about guardian consent no matter where it is quoted, and "we do
   * not send a confirmation link to anybody" is not.
   */
  it('each say who they are about', () => {
    const unscoped = guardianBullets().filter(b => !/guardian/i.test(b));

    expect(
      unscoped,
      'these bullets sit under a "Specifically:" lead-in about GUARDIAN consent and do not '
      + 'name a guardian, so read on their own they make claims about the whole application. '
      + 'Name the guardian in the sentence.',
    ).toEqual([]);
  });

  /**
   * And the two specific overstatements do not return.
   *
   * Belt and braces over the rule above — a bullet could name a guardian and
   * still say "to anybody" in the same breath, which is the exact sentence that
   * was wrong.
   */
  it('do not claim the platform never sends a link', () => {
    const body = policyContent('privacy-policy');
    expect(body).not.toMatch(/do not send a confirmation link\*{0,2}\s+to anybody/i);
    expect(body).not.toMatch(/nothing waits for an approval/i);
  });

  /** The commitment itself is still made, in the narrower form. */
  it('still promise no guardian confirmation link and no guardian approval gate', () => {
    const body = policyContent('privacy-policy');
    expect(body).toMatch(/do not send a guardian a confirmation link/i);
    expect(body).toMatch(/no part of your account waits for\s+a guardian's approval/i);
  });

  /**
   * And the section's own framing is intact.
   *
   * The bullets are only readable as guardian-scoped because a sentence above
   * them says so. If that lead-in ever goes, the bullets stop being a list of
   * what "no guardian consent step" means and become four free-standing claims.
   */
  it('are still introduced as what "no guardian consent step" means', () => {
    const body = policyContent('privacy-policy');
    const heading = body.indexOf(GUARDIAN_HEADING);
    const lead = body.slice(heading, heading + 400);
    expect(lead).toMatch(/no parent or guardian consent step/i);
    expect(lead).toMatch(/Specifically:/);
  });
});

/**
 * The claims the bullet used to make, checked against the application.
 *
 * These are the two facts that made the absolute wording false, asserted from
 * the code rather than from memory — so if either ever stops being true, the
 * narrower wording is revealed as unnecessary rather than silently kept.
 */
describe('why the absolute wording was wrong', () => {
  it('the platform does send links', async () => {
    const email = await import('./email.js');
    /* Four senders, each of which puts a link in a message. */
    for (const sender of [
      'sendVerificationEmail',
      'sendPasswordResetEmail',
      'sendAdminInvitationEmail',
      'sendEmailChangeConfirmation',
    ]) {
      expect(typeof email[sender], `${sender} should exist`).toBe('function');
    }
  });

  it('the platform does have approval workflows', async () => {
    const { REQUEST_DECISIONS } = await import('./organizationJoinRequests.js');
    /* A manager accepts or declines a request to join an organization, which is
       an approval gate by any reading. */
    expect(REQUEST_DECISIONS).toEqual(['accept', 'reject']);
  });
});
