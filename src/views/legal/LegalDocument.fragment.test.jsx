import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Deep links into a published policy have to land the reader on the section.
 *
 * ── The defect ──
 *
 * Two documents send a reader to one section of a third: the Data Deletion
 * Policy and the Cookie and Tracking Notice both link to
 * `/legal/privacy-policy#how-long-we-keep-things`. The anchor is real and the id
 * is correct, and the link still did not work — `LegalDocument` fetches the
 * markdown, so at the moment the browser resolves the fragment the heading does
 * not exist yet. The browser looks, finds nothing, and gives up silently. The
 * reader arrives at the top of a long Privacy Policy having just been told the
 * answer was over there.
 *
 * That failure is invisible to every other test in the suite: the page renders,
 * the anchor is present in the DOM, the link's href is right. Only the timing is
 * wrong, which is why this file exists rather than an assertion tacked onto a
 * render test.
 *
 * ── Focus, not just scroll ──
 *
 * A scroll-only fix serves the sighted mouse user. A keyboard user's focus stays
 * at the top of the document, so the next Tab walks the page from the beginning,
 * and a screen reader carries on reading wherever it already was. The deep link
 * either arrives for everybody or it is decoration, so the focus assertion here
 * is a requirement and not a nicety.
 *
 * ── `scrollIntoView` is called optionally on purpose ──
 *
 * jsdom does not implement it. That is a fair proxy for any environment that
 * lacks it, and the rule this pins is that a scrolling CONVENIENCE must never be
 * able to blank the page showing somebody the terms they are held to. The first
 * case runs with the method genuinely absent.
 */

const MARKDOWN = [
  '# Privacy Policy',
  '',
  '## What we collect',
  '',
  'Your name, your email, and the events you sign up for.',
  '',
  '## How long we keep things',
  '',
  'Until you ask us to delete them, with the exceptions listed below.',
  '',
  '## Your rights',
  '',
  'You can ask for a copy of everything we hold.',
].join('\n');

const DOC = {
  slug: 'privacy-policy',
  title: 'Privacy Policy',
  version: '1.0',
  effectiveAt: '2026-08-06',
  consentType: 'acknowledge',
  summary: 'What we collect and why.',
  markdown: MARKDOWN,
  contentHash: '0bfc976497fadbc231138363c73e556d21860435c4d1673d827536533c1a0c33',
};

const apiMock = vi.hoisted(() => ({ fetchLegalDocument: vi.fn() }));
vi.mock('../../utils/api', () => ({ api: apiMock }));

let LegalDocument;

async function renderAt(hash) {
  render(
    <MemoryRouter initialEntries={[`/legal/privacy-policy${hash}`]}>
      <Routes>
        <Route path="/legal/:slug" element={<LegalDocument />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByRole('heading', { name: 'How long we keep things' });
}

describe('LegalDocument deep links', () => {
  beforeEach(async () => {
    apiMock.fetchLegalDocument.mockResolvedValue(DOC);
    LegalDocument = (await import('./LegalDocument')).default;
  });

  afterEach(() => {
    delete window.matchMedia;
    delete Element.prototype.scrollIntoView;
    vi.clearAllMocks();
  });

  it('moves focus to the section a fragment names, once the document has loaded', async () => {
    await renderAt('#how-long-we-keep-things');

    const heading = screen.getByRole('heading', { name: 'How long we keep things' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('survives an environment with no scrollIntoView', () => {
    // Asserted by the case above having rendered and focused with the method
    // absent — this pins the precondition it depends on, so the guard cannot be
    // dropped on the grounds that "jsdom has it now".
    expect(Element.prototype.scrollIntoView).toBeUndefined();
  });

  it('scrolls the section into view when the browser can', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    await renderAt('#how-long-we-keep-things');

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ behavior: 'smooth', block: 'start' });
  });

  it('does not animate the jump when the reader asked for reduced motion', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.matchMedia = vi.fn(query => ({ matches: query.includes('reduce'), media: query }));

    await renderAt('#how-long-we-keep-things');

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ behavior: 'auto' });
  });

  it('leaves focus alone when there is no fragment', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    await renderAt('');

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
  });

  it('ignores a fragment naming no heading rather than failing the page', async () => {
    // A stale or hand-typed fragment must degrade to "you are at the top", never
    // to an error on the document somebody was sent to read.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    await renderAt('#how-long-we-keep-receipts');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Privacy Policy');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('ignores a malformed percent-escape instead of throwing out of the effect', async () => {
    // `decodeURIComponent('%E0%A4%A')` throws. An unhandled throw in an effect
    // unmounts the tree, which would turn a bad character in the address bar
    // into a blank policy page.
    await renderAt('#%E0%A4%A');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Privacy Policy');
  });
});
