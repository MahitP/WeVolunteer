import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import DemonstrationShowcase from './DemonstrationShowcase';
import { selfProfileFor, pageMetaFor, tabForPath, PAGE_META } from '../../App.jsx';

/**
 * The founder's profile (rulings 19 and 21, 2026-10-04).
 *
 * 19: "every badge, achievement, hour and streak" on his real account — drawn
 * on the profile as a demonstration, written nowhere. It must never read as a
 * record: it is labelled, it carries no dates, and it says the real record is
 * the one above it.
 *
 * 21: his page is a student's at any history. The server decides that from his
 * address and says so with `distinction.studentProfile`; nothing here matches
 * a name or an email.
 */

const SHOWCASE = {
  badges: [
    { id: 'b1', name: '5 Hours', description: 'Five confirmed hours', icon: '🏅', category: 'Service hours', criteria_value: 5 },
    { id: 'b2', name: '250 Hours', description: 'Two hundred and fifty confirmed hours', icon: '🏅', category: 'Service hours', criteria_value: 250 },
    { id: 'b3', name: '3 Month Streak', description: 'Three months in a row', icon: '🔥', category: 'Consistency', criteria_value: 3 },
  ],
  milestones: [
    { id: 'first-shift', label: 'First shift', hint: 'Completed your first volunteer shift' },
    { id: 'century', label: '100 hours', hint: 'One hundred hours of service' },
  ],
};

describe('the demonstration showcase', () => {
  it('shows every badge and milestone, labelled a demonstration', () => {
    render(<DemonstrationShowcase showcase={SHOWCASE} />);
    const card = screen.getByRole('region', { name: /every badge and milestone/i });
    expect(within(card).getByText('Demonstration')).toBeInTheDocument();
    for (const name of ['5 Hours', '250 Hours', '3 Month Streak', 'First shift', '100 hours']) {
      expect(within(card).getByText(name)).toBeInTheDocument();
    }
  });

  it('says it is not part of the record, and dates nothing', () => {
    const { container } = render(<DemonstrationShowcase showcase={SHOWCASE} />);
    expect(screen.getByText(/not part of this record/i)).toBeInTheDocument();
    expect(container.querySelector('time')).toBeNull();
  });

  it('renders nothing without a showcase', () => {
    const { container } = render(<DemonstrationShowcase showcase={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sits on both of the founder\'s profile pages', () => {
    for (const file of ['src/views/PublicProfile.jsx', 'src/views/VolunteerProfile.jsx']) {
      const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(src, file).toMatch(/<DemonstrationShowcase showcase=\{/);
    }
  });
});

describe('the founder\'s page is a student\'s at any history', () => {
  const owner = (over = {}) => ({ id: 'u-owner', role: 'super_admin', ...over });

  it('follows the server\'s flag at zero hours', () => {
    const founder = owner({ volunteeredHours: 0, distinction: { kind: 'owner', studentProfile: true } });
    expect(selfProfileFor(founder)).toBe('volunteer');
    expect(pageMetaFor(founder, tabForPath('/profile')).sub).toBe(PAGE_META.volunteer.profile.sub);
  });

  it('leaves every other owner history-driven', () => {
    expect(selfProfileFor(owner({ volunteeredHours: 0, distinction: { kind: 'owner' } }))).toBe('account');
  });

  it('shows the founder\'s Volunteering section on his public page at zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/views/PublicProfile.jsx'), 'utf8');
    expect(src).toMatch(/profile\.distinction\?\.studentProfile/);
  });
});
