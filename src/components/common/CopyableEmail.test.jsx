import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CopyableEmail from './CopyableEmail';

/**
 * FX-74, the owner: "Wherever u have mailto:… it doesn't work when you click on
 * it." A `mailto:` does nothing at all on a device with no mail app configured
 * — no error, no window — which is most school laptops and many phones. The
 * address is shown as text instead, with a Copy button that says it worked.
 */
describe('CopyableEmail', () => {
  it('shows the address as text, not as a mailto link', () => {
    render(<CopyableEmail address="support@wevolunteers.org" />);
    expect(screen.getByText('support@wevolunteers.org')).toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('copies the address and says so', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyableEmail address="support@wevolunteers.org" />);
    fireEvent.click(screen.getByRole('button', { name: /copy support@wevolunteers\.org/i }));
    expect(writeText).toHaveBeenCalledWith('support@wevolunteers.org');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/copied/i));
  });
});

describe('no mailto: links remain in the product', () => {
  it('in AboutUs or OrganizerProfile', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['src/views/AboutUs.jsx', 'src/views/OrganizerProfile.jsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/href=\{`mailto:/);
    }
  });
});
