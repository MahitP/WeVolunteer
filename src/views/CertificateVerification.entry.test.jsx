import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Getting to certificate verification without already knowing a code.
 *
 * ── The gap ──
 *
 * `/verify/:code` is public and is the link printed on a certificate, which
 * makes it the one page that only works for somebody who does not need it: you
 * reach it by having the code in a URL already. Reported as "there's no way to
 * go to /verify unless u go to the specific link".
 *
 * Two halves. `/verify` on its own now renders a box to type a code into — the
 * same page, because everything after the code is entered (the shape check, the
 * rate-limit handling, the separation of "forged" from "we could not reach the
 * server") already exists there and must not be written twice. And Welly's
 * composer footer links to it, which is covered at the bottom of this file.
 */

const apiMock = { verifyCertificate: vi.fn() };
vi.mock('../utils/api', () => ({ api: apiMock }));

const { default: CertificateVerification } = await import('./CertificateVerification.jsx');

const at = path => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/verify" element={<CertificateVerification />} />
      <Route path="/verify/:code" element={<CertificateVerification />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { vi.clearAllMocks(); });

describe('/verify with no code', () => {
  it('asks for a code instead of reporting a failed verification', () => {
    at('/verify');

    expect(screen.getByRole('heading', { name: /check a certificate/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/certificate code/i)).toBeInTheDocument();
    /* The old missing-code branch fell through to the invalid state, which
       reads "The code could not be found in our records" — an accusation of
       forgery aimed at somebody who typed a URL. */
    expect(screen.queryByText(/Invalid Certificate/i)).toBeNull();
    expect(screen.queryByText(/may be forged/i)).toBeNull();
  });

  it('spends no request on something that cannot be a code', () => {
    at('/verify');
    fireEvent.change(screen.getByLabelText(/certificate code/i), { target: { value: 'hello' } });

    expect(screen.getByRole('button', { name: /check this code/i })).toBeDisabled();
    expect(screen.getByText(/Codes look like WEV-XXXX-XXXX/)).toBeInTheDocument();
    expect(apiMock.verifyCertificate).not.toHaveBeenCalled();
  });

  it('verifies a well-formed code, typed in any case', () => {
    apiMock.verifyCertificate.mockResolvedValue({ valid: false });
    at('/verify');

    fireEvent.change(screen.getByLabelText(/certificate code/i), { target: { value: 'wev-ab29-7kmz' } });
    fireEvent.click(screen.getByRole('button', { name: /check this code/i }));

    /* Upper-cased on the way to the URL, so the code a reader copies off a
       certificate works whatever their keyboard did to it. */
    expect(apiMock.verifyCertificate).toHaveBeenCalledWith('WEV-AB29-7KMZ');
  });
});

describe('/verify with a code still works exactly as before', () => {
  it('goes straight to verifying', () => {
    apiMock.verifyCertificate.mockResolvedValue({ valid: true, hours: 4, eventTitle: 'Beach Cleanup' });
    at('/verify/WEV-AB29-7KMZ');

    expect(apiMock.verifyCertificate).toHaveBeenCalledWith('WEV-AB29-7KMZ');
    expect(screen.queryByLabelText(/certificate code/i)).toBeNull();
  });

  it('still rejects a malformed code without asking the server', () => {
    at('/verify/NOT-A-CODE');
    expect(apiMock.verifyCertificate).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid Certificate/i)).toBeInTheDocument();
  });
});

describe('the way in from inside the app', () => {
  /**
   * Welly's composer footer, of the four navigation destinations.
   *
   * Verifying a code is a lookup and Welly is where lookups happen — it already
   * has `verify_certificate` as a tool, so this is a second door to something
   * that is here rather than a feature borrowed from another page. The footer
   * rather than the empty state or the sidebar: the empty state disappears at
   * the first message, and the sidebar is a drawer on a phone.
   */
  it('is reachable from Welly at every viewport height', async () => {
    const { default: WellyView } = await import('./WellyView.jsx');
    render(
      <MemoryRouter>
        <WellyView currentUser={{ id: 'stu-verify-1', name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /check a certificate/i });
    expect(link).toHaveAttribute('href', '/verify');

    /**
     * The short-viewport block hides the footer to reclaim a line, which used
     * to cost only a reassurance the reader had already seen. It now holds the
     * only route to verification inside the app, so the rule hides the SPAN and
     * leaves the link — a route that exists at one viewport height and not
     * another is not a route.
     *
     * Asserted against the stylesheet rather than a computed style, because
     * jsdom applies no media queries at all: a `getComputedStyle` check here
     * would pass whatever the rule said.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
    /* The brace matters: there is an earlier `@media (max-height: 520px) and
       (orientation: landscape)` block, and a prefix match lands in that one. */
    const start = css.indexOf('@media (max-height: 520px) {');
    expect(start).toBeGreaterThan(-1);
    /* To the closing brace of the media block: it is the only `}` in column
       zero after the opening, because every rule inside is indented. */
    const short = css.slice(start, css.indexOf('\n}', start) + 2);

    expect(short).toMatch(/\.welly-composer-footer > span \{\s*display: none;/);
    /* And the row itself is NOT hidden, which is what the rule used to do. */
    expect(short).not.toMatch(/\.welly-composer-footer \{[^}]*display:\s*none/);
  });
});
