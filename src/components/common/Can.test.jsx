import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Can } from './Can.jsx';

describe('<Can>', () => {
  it('renders children when the user has the capability', () => {
    render(<Can user={{ id: 'u1', role: 'admin' }} cap="organizer.approve">
      <button>Approve</button>
    </Can>);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('renders nothing when the user lacks it', () => {
    render(<Can user={{ id: 'u1', role: 'student' }} cap="organizer.approve">
      <button>Approve</button>
    </Can>);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('renders the fallback when provided', () => {
    render(<Can user={{ id: 'u1', role: 'student' }} cap="organizer.approve" fallback={<p>Not allowed</p>}>
      <button>Approve</button>
    </Can>);
    expect(screen.getByText('Not allowed')).toBeInTheDocument();
  });
});
