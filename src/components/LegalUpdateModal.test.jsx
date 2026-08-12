import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  api: { fetchLegalUpdates: vi.fn(), acknowledgeLegalUpdate: vi.fn() },
}));

import LegalUpdateModal from './LegalUpdateModal';
import { api } from '../utils/api';

/**
 * The popup that tells somebody a legal document changed.
 *
 * The Terms promise notice in the app. These pin the two ways that promise can
 * be broken without anybody noticing: showing nothing, and showing something so
 * relentless that people learn to dismiss legal text unread.
 */

const UPDATE = {
  slug: 'privacy-policy',
  title: 'Privacy Policy',
  version: '1.1',
  previousVersion: '1.0',
  excerpt: 'We now keep volunteer attendance records for three school years rather than one.',
  changeCount: 1,
  isSample: false,
};

const draw = () => render(<MemoryRouter><LegalUpdateModal /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.acknowledgeLegalUpdate.mockResolvedValue({ ok: true });
});

describe('when a document has changed', () => {
  beforeEach(() => api.fetchLegalUpdates.mockResolvedValue({ updates: [UPDATE] }));

  it('names the document in the heading', async () => {
    draw();
    expect(await screen.findByText('Privacy Policy has been updated')).toBeInTheDocument();
  });

  it('quotes what is new', async () => {
    draw();
    expect(await screen.findByText(/three school years/)).toBeInTheDocument();
  });

  it('links to the full document', async () => {
    draw();
    const link = await screen.findByRole('link', { name: /Read the Privacy Policy/i });
    expect(link.getAttribute('href')).toBe('/legal/privacy-policy');
  });

  it('is a proper dialog, so Escape and focus are handled', async () => {
    draw();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toMatch(/Privacy Policy/);
  });

  it('records the acknowledgement when dismissed', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Got it/i }));
    await waitFor(() => expect(api.acknowledgeLegalUpdate).toHaveBeenCalledWith('privacy-policy', '1.1'));
  });

  it('goes away once dismissed', async () => {
    const { container } = draw();
    fireEvent.click(await screen.findByRole('button', { name: /Got it/i }));
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
  });
});

describe('honesty about the excerpt', () => {
  it('says the quote is one of several when it is', async () => {
    /* The excerpt cannot know which change matters most. Presenting one as
       "what changed" would overstate it. */
    api.fetchLegalUpdates.mockResolvedValue({
      updates: [{ ...UPDATE, changeCount: 4, isSample: true }],
    });
    draw();
    expect(await screen.findByText(/one of 4 changes/)).toBeInTheDocument();
  });

  it('does not claim a quote when nothing quotable was added', async () => {
    /* A deletion-only change is real and must still notify — but inventing a
       sentence would put words in the document's mouth. */
    api.fetchLegalUpdates.mockResolvedValue({ updates: [{ ...UPDATE, excerpt: null, changeCount: 0 }] });
    const { container } = draw();

    await screen.findByText(/wording has been revised/i);
    expect(container.querySelector('.legal-excerpt')).toBeNull();
  });
});

describe('several at once', () => {
  it('shows them one at a time rather than stacking modals', async () => {
    /* Three stacked dialogs is a wall somebody dismisses without reading —
       which is the exact failure this feature exists to prevent. */
    api.fetchLegalUpdates.mockResolvedValue({
      updates: [UPDATE, { ...UPDATE, slug: 'terms-of-service', title: 'Terms of Service' }],
    });
    const { container } = draw();

    await screen.findByText('Privacy Policy has been updated');
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(await screen.findByText(/1 more update/)).toBeInTheDocument();
  });

  it('advances to the next after the first is dismissed', async () => {
    api.fetchLegalUpdates.mockResolvedValue({
      updates: [UPDATE, { ...UPDATE, slug: 'terms-of-service', title: 'Terms of Service' }],
    });
    draw();

    fireEvent.click(await screen.findByRole('button', { name: /Got it/i }));
    expect(await screen.findByText('Terms of Service has been updated')).toBeInTheDocument();
  });
});

describe('renders nothing when', () => {
  it('there is nothing to say', async () => {
    api.fetchLegalUpdates.mockResolvedValue({ updates: [] });
    const { container } = draw();
    await waitFor(() => expect(api.fetchLegalUpdates).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('the request fails', async () => {
    /* A student who opened the app to find a shift must not be shown an error
       about a notice system they never asked about. */
    api.fetchLegalUpdates.mockRejectedValue(new Error('offline'));
    const { container } = draw();
    await waitFor(() => expect(api.fetchLegalUpdates).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('it cannot trap somebody', () => {
  it('still dismisses when the acknowledgement request fails', async () => {
    /**
     * The server upsert is idempotent and the version comparison will simply
     * offer the notice again. Leaving a person stuck behind a modal they cannot
     * close is far worse than showing it twice.
     */
    api.fetchLegalUpdates.mockResolvedValue({ updates: [UPDATE] });
    api.acknowledgeLegalUpdate.mockRejectedValue(new Error('500'));

    const { container } = draw();
    fireEvent.click(await screen.findByRole('button', { name: /Got it/i }));

    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
  });
});
