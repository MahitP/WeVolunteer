import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Welcome from './Welcome';

/**
 * The one privacy sentence on the signed-out page, which parents read before a
 * student signs up.
 *
 * It said "Your information is only shared with the organizers of shifts you
 * apply to." Profiles became visible to every signed-in member (P2-18), so
 * that stopped being true — on a page published to the public, by an operator
 * who is personally bound by what it promises (Posture B). The replacement says
 * what is actually so, each clause traceable to code:
 *   - profiles need a signed-in member (`/users/:handle` requires directory.read);
 *   - email, school and grade reach organizers through the roster they export;
 *   - other members see school and grade only on a public profile, and sign-up
 *     never sets one (the column defaults to private).
 */
describe('the Welcome page privacy line', () => {
  it('no longer says information goes only to organizers', () => {
    render(<MemoryRouter><Welcome /></MemoryRouter>);
    expect(screen.queryByText(/only shared with the organizers/i)).toBeNull();
  });

  it('says who sees what, accurately', () => {
    render(<MemoryRouter><Welcome /></MemoryRouter>);
    expect(screen.getByText(/Profiles are seen only by people signed in to WeVolunteer/i)).toBeInTheDocument();
    expect(screen.getByText(/only if you choose to show them/i)).toBeInTheDocument();
  });
});
