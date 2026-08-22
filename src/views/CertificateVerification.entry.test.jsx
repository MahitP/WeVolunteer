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
   * ── It moved, and this file records where from ──
   *
   * This asserted a "Check a certificate" link in Welly's composer footer, and
   * a CSS rule keeping that footer visible at short viewport heights so the
   * link could not vanish.
   *
   * Both are gone. The entry point is a button on all three dashboards, which
   * `verifyCertificateEntry.test.jsx` covers across every role — a better place
   * than a footnote under a chat box, and it is where it was asked for. The
   * footer now carries Welly's disclaimer instead: "I do think a small legal
   * disclaimer would fit its place."
   *
   * What is asserted here is the half that would otherwise be nobody's job —
   * that the route did not simply disappear when it moved.
   */
  it('is not left behind under the composer', async () => {
    const { default: WellyView } = await import('./WellyView.jsx');
    render(
      <MemoryRouter>
        <WellyView currentUser={{ id: 'stu-verify-1', name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: /check a certificate/i })).toBeNull();
  });

  it('is reachable from the dashboard instead', async () => {
    /* One assertion here so this file's subject — how somebody gets to
       verification — stays answerable from this file. The per-role matrix is in
       verifyCertificateEntry.test.jsx. */
    const { default: VerifyCertificateAction } = await import('../components/common/VerifyCertificateAction');
    render(<MemoryRouter><VerifyCertificateAction /></MemoryRouter>);

    const link = screen.getByRole('link', { name: /verify a certificate/i });
    expect(link).toHaveAttribute('href', '/verify');
    /* And it looks like a button rather than a line of text — `btn-ghost` is
       `background: transparent` with no border, which is what it used to be. */
    expect(link.className).toMatch(/\bbtn\b/);
    expect(link.className).not.toMatch(/btn-ghost/);
  });
});
