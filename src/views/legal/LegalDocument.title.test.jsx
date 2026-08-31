import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { APP_NAME } from '../../config';

/**
 * The browser tab names the document, not the dashboard.
 *
 * ── What was wrong ──
 *
 * `tabForPath` had no `/legal` branch, so every path under it fell through to
 * `return 'dashboard'` and `App.jsx` titled the tab from the dashboard's
 * PAGE_META entry. Measured live on `/legal/accessibility-statement`: the URL
 * and the rendered document were correct and `document.title` said
 * "Dashboard · WeVolunteer".
 *
 * That is WCAG 2.4.2. It lands hardest on this route in particular: a screen
 * reader announces the title on navigation, and legal documents are the pages
 * somebody is most likely to have open in several background tabs at once,
 * comparing one against another — which is precisely the situation where every
 * tab reading "Dashboard" leaves them nothing to navigate by.
 *
 * ── Why the fix is in two places, and both are tested ──
 *
 * The route now maps to a `legal` tab, so the catalogue and the loading state
 * are titled "Legal Center" — that half is held by `pageTitleCoverage.test.js`,
 * which no longer exempts `/legal`. The DOCUMENT's own name cannot come from a
 * route table, because thirteen documents share one route and the name arrives
 * with the fetch. That half is here.
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

async function renderAt(slug, resolver) {
  apiMock.fetchLegalDocument.mockImplementation(resolver);
  ({ default: LegalDocument } = await import('./LegalDocument'));
  return render(
    <MemoryRouter initialEntries={[`/legal/${slug}`]}>
      <Routes><Route path="/legal/:slug" element={<LegalDocument />} /></Routes>
    </MemoryRouter>
  );
}

/** The title the shell would have left on the tab before this page mounted. */
const SHELL_TITLE = 'Legal Center · WeVolunteer';

beforeEach(() => {
  vi.clearAllMocks();
  document.title = SHELL_TITLE;
});
afterEach(() => cleanup());

describe('the browser tab on a legal document', () => {
  it('names the document once it has loaded', async () => {
    await renderAt('privacy-policy', async () => DOC());

    await waitFor(() => expect(document.title).toBe(`Privacy Policy · ${APP_NAME}`));
  });

  it('is not the dashboard, which is the defect this exists for', async () => {
    await renderAt('privacy-policy', async () => DOC());

    await screen.findByText(/^Version \d/);
    expect(document.title).not.toMatch(/dashboard/i);
  });

  /**
   * Every document, not one hard-coded string.
   *
   * A single generic "Legal document" title would satisfy a naive reading of
   * the requirement and leave the background-tab problem exactly as it was.
   */
  it.each([
    ['terms-of-service', 'Terms of Service'],
    ['youth-safety-guidelines', 'Youth Safety Guidelines'],
    ['cookie-and-tracking-notice', 'Cookie and Tracking Notice'],
    ['accessibility-statement', 'Accessibility'],
  ])('titles /legal/%s as "%s"', async (slug, title) => {
    await renderAt(slug, async () => DOC({ slug, title }));

    await waitFor(() => expect(document.title).toBe(`${title} · ${APP_NAME}`));
  });

  it('leaves the shell title alone while the document is loading', async () => {
    /* A never-resolving fetch is the loading state held still. The reader should
       see the Legal Center's name, not a flicker through a placeholder. */
    await renderAt('privacy-policy', () => new Promise(() => {}));

    expect(document.title).toBe(SHELL_TITLE);
  });

  it('says so when there is no such document', async () => {
    const err = new Error('nope');
    err.status = 404;
    await renderAt('not-a-real-policy', async () => { throw err; });

    await waitFor(() => expect(document.title).toBe(`No such document · ${APP_NAME}`));
  });

  it('says so when the document cannot be fetched', async () => {
    const err = new Error('boom');
    err.status = 500;
    await renderAt('privacy-policy', async () => { throw err; });

    await waitFor(() => expect(document.title).toBe(`Document unavailable · ${APP_NAME}`));
  });

  it('restores the shell title when the reader leaves', async () => {
    /* `App.jsx`'s effect only re-runs on a pathname change, and a signed-out
       reader has no such effect at all, so the restore is what stops one
       document's name outliving the page. */
    const view = await renderAt('privacy-policy', async () => DOC());
    await waitFor(() => expect(document.title).toBe(`Privacy Policy · ${APP_NAME}`));

    view.unmount();
    expect(document.title).toBe(SHELL_TITLE);
  });
});
