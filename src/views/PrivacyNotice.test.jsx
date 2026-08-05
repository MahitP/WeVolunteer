/**
 * The privacy notice, and the property that makes it safe to ship.
 *
 * `src/config.js` states the rule this page has to obey: shipping placeholder
 * legal text is worse than shipping none, because it manufactures the
 * appearance of a reviewed policy. This page exists anyway — the factual half
 * (what is stored, who can see it) is readable from the schema and is true
 * wherever the software runs, and stating it beats the previous behaviour,
 * which was silence.
 *
 * So the tests below are not really about rendering. They pin the boundary:
 * the factual sections always appear, the district's three decisions are never
 * invented, and while any of them is missing the page says so ABOVE the
 * reassuring content rather than below it. A refactor that quietly filled in a
 * default would pass a "does it render" test and fail these.
 *
 * The config module is mocked rather than driving `import.meta.env`, because
 * Vite inlines those at build time — a test that set `import.meta.env.VITE_*`
 * at runtime would assert against a value the component never reads.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const config = vi.hoisted(() => ({
  APP_NAME: 'WeVolunteer',
  SCHOOL_NAME: 'WeVolunteer Community',
  PRIVACY_CONTACT: '',
  PRIVACY_RETENTION: '',
  PRIVACY_UNDER13: '',
  PRIVACY_OWNER: '',
  privacyNoticeComplete: () => false,
}));

vi.mock('../config', () => config);

/** Sets the district-supplied values for one test, complete or otherwise. */
function district(values = {}) {
  Object.assign(config, {
    PRIVACY_CONTACT: '', PRIVACY_RETENTION: '', PRIVACY_UNDER13: '', PRIVACY_OWNER: '',
    ...values,
  });
  config.privacyNoticeComplete = () => Boolean(
    config.PRIVACY_CONTACT && config.PRIVACY_RETENTION
    && config.PRIVACY_UNDER13 && config.PRIVACY_OWNER
  );
}

const COMPLETE = {
  PRIVACY_OWNER: 'Lincoln Unified School District',
  PRIVACY_RETENTION: 'Records are kept for three years after graduation.',
  PRIVACY_CONTACT: 'Email privacy@lincoln.k12.example.',
  PRIVACY_UNDER13: 'Accounts under 13 require a signed parental consent form.',
};

let PrivacyNotice;
beforeEach(async () => {
  district();
  vi.resetModules();
  PrivacyNotice = (await import('./PrivacyNotice')).default;
});
afterEach(() => { vi.clearAllMocks(); });

describe('the facts the software can state itself', () => {
  it('always describes what is collected and who can see it', async () => {
    render(<PrivacyNotice />);

    expect(screen.getByRole('heading', { name: /what is collected/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /who can see it/i })).toBeInTheDocument();

    // The specifics that make it a disclosure rather than a gesture.
    expect(screen.getByText(/one-way hash of the password/i)).toBeInTheDocument();
    expect(screen.getByText(/private by default/i)).toBeInTheDocument();
    expect(screen.getByText(/off unless a student turns it on/i)).toBeInTheDocument();
  });

  it('states them even when the district has supplied nothing', () => {
    render(<PrivacyNotice />);
    expect(screen.getByRole('heading', { name: /what is collected/i })).toBeInTheDocument();
  });
});

describe('the three decisions the software must not invent', () => {
  /**
   * The heart of it. A missing district value must render as a NAMED absence,
   * never as a plausible sentence and never as a silently omitted section — an
   * absent section reads as "does not apply", which is a different and false
   * claim.
   */
  it.each([
    ['retention', /how long records are kept/i],
    ['deletion contact', /correcting or deleting your information/i],
    ['under-13 consent', /users under 13/i],
  ])('marks %s as not yet provided instead of inventing it', (_label, heading) => {
    render(<PrivacyNotice />);
    const section = screen.getByRole('heading', { name: heading }).parentElement;
    expect(section).toHaveTextContent(/not yet provided/i);
  });

  it('shows the district text once supplied, and drops the admission', () => {
    district(COMPLETE);
    render(<PrivacyNotice />);

    expect(screen.getByText(COMPLETE.PRIVACY_RETENTION)).toBeInTheDocument();
    expect(screen.getByText(COMPLETE.PRIVACY_CONTACT)).toBeInTheDocument();
    expect(screen.getByText(COMPLETE.PRIVACY_UNDER13)).toBeInTheDocument();
    expect(screen.queryByText(/not yet provided/i)).not.toBeInTheDocument();
  });
});

describe('an unfinished notice says so, and says it first', () => {
  it('warns that it is not a reviewed policy while anything is missing', () => {
    render(<PrivacyNotice />);
    expect(screen.getByText(/this notice is not finished/i)).toBeInTheDocument();
    expect(screen.getByText(/not a reviewed\s+privacy policy/i)).toBeInTheDocument();
  });

  /**
   * Position, not just presence. A reader who stops partway must still come
   * away knowing the page is incomplete, so the warning has to precede the
   * content that reads as reassurance. `compareDocumentPosition` is the only
   * assertion that actually pins order — a `getByText` for both would pass
   * with the warning at the bottom of the page.
   */
  it('places the warning above the reassuring content', () => {
    render(<PrivacyNotice />);
    const warning = screen.getByText(/this notice is not finished/i);
    const reassuring = screen.getByRole('heading', { name: /what .* does not do/i });

    expect(
      warning.compareDocumentPosition(reassuring) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the incomplete-notice warning must come before the "what it does not do" section'
    ).toBeTruthy();
  });

  it('drops the warning entirely once every value is supplied', () => {
    district(COMPLETE);
    render(<PrivacyNotice />);
    expect(screen.queryByText(/this notice is not finished/i)).not.toBeInTheDocument();
  });

  it('attributes the policy to the district once one is named', () => {
    district(COMPLETE);
    render(<PrivacyNotice />);
    expect(
      screen.getByRole('heading', { name: /Lincoln Unified School District/i })
    ).toBeInTheDocument();
  });

  /**
   * One partial value must not be enough. Three of four filled in is the state
   * most likely to occur in practice — somebody works down the list and stops —
   * and it is exactly when a page that looked finished would be most misleading.
   */
  it.each(Object.keys(COMPLETE))('still warns when only %s is missing', (missing) => {
    district({ ...COMPLETE, [missing]: '' });
    render(<PrivacyNotice />);
    expect(screen.getByText(/this notice is not finished/i)).toBeInTheDocument();
  });
});
