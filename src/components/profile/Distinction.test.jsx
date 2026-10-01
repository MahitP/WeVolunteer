/**
 * The presentation an account that is not an ordinary member carries.
 *
 * ── What these tests are really guarding ──
 *
 * Two things, and neither is layout.
 *
 * First, that the treatment is derived from ROLE DATA and nothing else. The
 * account this was built for belongs to a high-school student who also runs the
 * platform, and the tempting shortcut — keying the presentation off a username,
 * an id, or a hardcoded list — would work perfectly until the day the account
 * changed hands or a second partner arrived. Every test below drives the
 * component with a `distinction` object and never with a name.
 *
 * Second, that it stays ADDITIVE. A distinguished profile is a member profile
 * with something above it, not a different page: the owner's hours and interests
 * are real and belong on their profile exactly as anybody else's do.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DistinctionBanner, DistinctionTag } from './Distinction';

/** The shape the server sends — see DISTINCTIONS in server/profileSerializer.js. */
const OWNER = {
  kind: 'owner',
  label: 'Platform owner',
  blurb: 'Runs WeVolunteer.',
  description: 'This account runs WeVolunteer.',
  highlightsLabel: 'What this account does here',
};
const PARTNER = {
  kind: 'partner',
  label: 'Community partner',
  blurb: 'An outside organization that works with WeVolunteer.',
  description: 'A community partner is an organization outside the school.',
  highlightsLabel: 'What we do',
};

describe('an ordinary account', () => {
  /* No branch in the calling view — the component answers for itself, so a
     student profile cannot accidentally grow a role banner. */
  it('renders nothing at all', () => {
    const { container } = render(<DistinctionBanner distinction={null} headline="Hi" />);
    expect(container).toBeEmptyDOMElement();
    const tag = render(<DistinctionTag distinction={undefined} />);
    expect(tag.container).toBeEmptyDOMElement();
  });
});

describe.each([['owner', OWNER], ['partner', PARTNER]])('a %s account', (kind, distinction) => {
  const full = () => render(
    <DistinctionBanner
      distinction={distinction}
      headline="One line in their own words."
      about="A longer paragraph they wrote themselves."
      highlights={['First thing', 'Second thing']}
    />
  );

  it('is announced by its role, as a heading', () => {
    full();
    const heading = screen.getByRole('heading', { level: 2, name: distinction.label });
    expect(heading).toBeTruthy();
  });

  /* A named region, so a screen-reader user can reach the card and leave it as
     a unit rather than wading through it. An unnamed region would be worse than
     none. */
  it('is a region named by that heading', () => {
    full();
    const region = screen.getByRole('region', { name: distinction.label });
    expect(region.getAttribute('data-kind')).toBe(kind);
  });

  it('shows the account holder\'s own words and the platform\'s explanation', () => {
    full();
    expect(screen.getByText('One line in their own words.')).toBeTruthy();
    expect(screen.getByText('A longer paragraph they wrote themselves.')).toBeTruthy();
    expect(screen.getByText(distinction.description)).toBeTruthy();
  });

  /* The heading order the page depends on: `h1` name, `h2` role, `h3` sub-block.
     The visual difference between h2 and h3 here is small, which is not a reason
     to flatten them — the order is what a screen reader navigates by. */
  it('puts its sub-block heading at h3, under the h2', () => {
    full();
    expect(screen.getByRole('heading', { level: 3, name: distinction.highlightsLabel })).toBeTruthy();
  });

  /* A list stays a list, so the count is announced. */
  it('lists highlights as list items', () => {
    full();
    expect(screen.getAllByRole('listitem').map(li => li.textContent.trim()))
      .toEqual(['First thing', 'Second thing']);
  });

  /* The rule the whole profile follows: a field the server withheld is not
     drawn as an empty section implying the holder left it blank. */
  it('draws nothing for the parts that are absent', () => {
    render(<DistinctionBanner distinction={distinction} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: distinction.label })).toBeTruthy();
  });

  /* Every icon here duplicates adjacent text, so none of them should be
     announced. The two kinds differ by hue in CSS, which is exactly why the
     text label is load-bearing. */
  it('marks its icons decorative', () => {
    const { container } = full();
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders the compact tag with the same label', () => {
    render(<DistinctionTag distinction={distinction} />);
    expect(screen.getByText(distinction.label)).toBeTruthy();
  });
});

/**
 * ── Derived from role data, never from who the account belongs to ──
 *
 * The same component, handed the same distinction, must produce the same
 * treatment whatever the account is called. This is the test that fails if
 * anybody reintroduces a name check.
 */
describe('the treatment is a function of the role alone', () => {
  it('is identical for two different accounts holding the same role', () => {
    const a = render(<DistinctionBanner distinction={PARTNER} headline="Alpha Trust" />);
    const first = a.container.innerHTML.replace('Alpha Trust', 'NAME');
    a.unmount();

    const b = render(<DistinctionBanner distinction={PARTNER} headline="Beta Foundation" />);
    const second = b.container.innerHTML.replace('Beta Foundation', 'NAME');

    expect(second).toBe(first);
  });

  /* A kind the component has never heard of still renders its label and its
     own words rather than nothing — a new role added server-side degrades to a
     sensible page instead of a blank one. */
  it('renders a kind it does not know about', () => {
    render(<DistinctionBanner
      distinction={{ kind: 'advisor', label: 'Programme advisor', blurb: 'Advises.' }}
      headline="Advising since 2020."
    />);
    expect(screen.getByRole('heading', { level: 2, name: 'Programme advisor' })).toBeTruthy();
    expect(screen.getByText('Advising since 2020.')).toBeTruthy();
  });
});
