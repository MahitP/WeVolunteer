import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * The version line on a published document.
 *
 * ── Why "last revised" is conditional, and why that needs a test ──
 *
 * A document carries two dates once the Legal Center editor exists.
 * `effectiveAt` is the date the owner put on the version; `updatedAt` is when the
 * revision was actually published. They are the same day for almost every save,
 * and printing both then makes a reader stop and work out whether two dates
 * disagree for a reason. When they genuinely differ — a correction published on
 * Tuesday carrying Monday's date — that gap is the thing somebody checking
 * whether this text is current actually wants.
 *
 * So the line is different in three situations and only one of them is the
 * common case, which is exactly the shape that regresses quietly: whichever
 * branch a future edit breaks, the page still renders and every other test still
 * passes.
 */

const MARKDOWN = '# Privacy Policy\n\nWhat we collect and why.\n';

const DOC = (over = {}) => ({
  slug: 'privacy-policy',
  title: 'Privacy Policy',
  version: '1.0',
  effectiveAt: '2026-08-06',
  consentType: 'acknowledge',
  summary: 'What we collect and why.',
  markdown: MARKDOWN,
  contentHash: 'a'.repeat(64),
  updatedAt: null,
  ...over,
});

const apiMock = vi.hoisted(() => ({ fetchLegalDocument: vi.fn() }));
vi.mock('../../utils/api', () => ({ api: apiMock }));

let LegalDocument;

const renderDoc = async (doc) => {
  apiMock.fetchLegalDocument.mockResolvedValue(doc);
  ({ default: LegalDocument } = await import('./LegalDocument'));
  render(
    <MemoryRouter initialEntries={['/legal/privacy-policy']}>
      <Routes><Route path="/legal/:slug" element={<LegalDocument />} /></Routes>
    </MemoryRouter>
  );
  /* Matched on the label rather than a version number, so a case using 2.0.0
     does not silently fail to find the line it is asserting about. */
  return screen.findByText(/^Version \d/);
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the version line', () => {
  it('always names the version and the effective date', async () => {
    const meta = await renderDoc(DOC());
    expect(meta).toHaveTextContent('Version 1.0');
    expect(meta).toHaveTextContent('in effect since August 6, 2026');
  });

  /**
   * The common case: no revision has ever been published, so `updatedAt` is null
   * and there is nothing extra to say.
   */
  it('says nothing about revision when the document has never been edited', async () => {
    const meta = await renderDoc(DOC({ updatedAt: null }));
    expect(meta).not.toHaveTextContent('last revised');
  });

  /* Same day: the two dates agree, so printing both would be noise. */
  it('omits the revision date when it matches the effective date', async () => {
    const meta = await renderDoc(DOC({
      version: '1.1.0', effectiveAt: '2026-09-01', updatedAt: '2026-09-01T14:05:00.000Z',
    }));
    expect(meta).toHaveTextContent('in effect since September 1, 2026');
    expect(meta).not.toHaveTextContent('last revised');
  });

  /* Different days: the gap is the point. */
  it('shows the revision date when it differs from the effective date', async () => {
    const meta = await renderDoc(DOC({
      version: '1.1.0', effectiveAt: '2026-09-07', updatedAt: '2026-09-01T14:05:00.000Z',
    }));
    expect(meta).toHaveTextContent('in effect since September 7, 2026');
    expect(meta).toHaveTextContent('last revised September 1, 2026');
  });

  /**
   * An ISO timestamp must be read as a plain date.
   *
   * `updatedAt` arrives as a full timestamp, and `new Date('2026-09-01')` is
   * midnight UTC — which prints as August 31 for every reader west of Greenwich.
   * A revision date that is a day early is the kind of error nobody notices until
   * it is the thing being argued about.
   */
  it('reads a timestamp as the calendar day it names', async () => {
    const meta = await renderDoc(DOC({
      version: '2.0.0', effectiveAt: '2026-09-07', updatedAt: '2026-09-01T02:30:00.000Z',
    }));
    expect(meta).toHaveTextContent('last revised September 1, 2026');
    expect(meta).not.toHaveTextContent('August 31');
  });
});
