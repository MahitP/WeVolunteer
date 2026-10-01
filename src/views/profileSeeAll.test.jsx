import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { seeAllHref } from './VolunteerProfile';
import PreviewList from '../components/common/PreviewList';

/**
 * "Show all" on a profile goes to the record of the person whose profile it
 * is. On somebody else's profile it went to YOUR `/hours` and YOUR
 * `/certificates` (A3) — an organizer looking at an applicant was sent to a
 * page of their own they could not even open — and the badges link was built
 * as `/users/@undefined/badges` for an account without a username (A4).
 */
describe('a profile\'s "see all" links', () => {
  it('go to your own pages on your own profile', () => {
    expect(seeAllHref('hours', { isSelf: true, username: 'aarav' })).toBe('/hours');
    expect(seeAllHref('certificates', { isSelf: true, username: 'aarav' })).toBe('/certificates');
    expect(seeAllHref('badges', { isSelf: true, username: 'aarav' })).toBe('/profile/badges');
  });

  it("go to the other person's public pages on theirs", () => {
    expect(seeAllHref('hours', { isSelf: false, username: 'maya' })).toBe('/users/@maya/hours');
    expect(seeAllHref('certificates', { isSelf: false, username: 'maya' })).toBe('/users/@maya/certificates');
    expect(seeAllHref('badges', { isSelf: false, username: 'maya' })).toBe('/users/@maya/badges');
  });

  it('give no link at all, rather than @undefined, when there is no username', () => {
    for (const kind of ['hours', 'certificates', 'badges']) {
      expect(seeAllHref(kind, { isSelf: false, username: undefined })).toBeNull();
    }
  });

  it('a shortened list with nowhere to go says how many more, without a dead link', () => {
    render(
      <MemoryRouter>
        <PreviewList items={[1, 2, 3, 4]} cap={2} label="shifts" moreHref={null}
          renderItem={(n) => <div key={n}>item {n}</div>} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/and 2 more/i)).toBeInTheDocument();
  });
});
