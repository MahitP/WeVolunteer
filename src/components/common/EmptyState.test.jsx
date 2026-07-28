import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Calendar } from 'lucide-react';
import EmptyState from './EmptyState';

describe('EmptyState', () => {
  it('renders the title and message it is given', () => {
    render(<EmptyState title="No applications yet" message="Find a shift to get started." />);

    expect(screen.getByRole('heading', { name: 'No applications yet' })).toBeInTheDocument();
    expect(screen.getByText('Find a shift to get started.')).toBeInTheDocument();
  });

  it('renders an action when one is supplied, and omits the wrapper when not', () => {
    const { rerender } = render(
      <EmptyState title="No events" action={<button>Browse events</button>} />
    );
    expect(screen.getByRole('button', { name: 'Browse events' })).toBeInTheDocument();

    rerender(<EmptyState title="No events" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('accepts a custom icon without erroring', () => {
    render(<EmptyState icon={Calendar} title="Nothing scheduled" />);
    expect(screen.getByRole('heading', { name: 'Nothing scheduled' })).toBeInTheDocument();
  });
});
