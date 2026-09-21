import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CertificateView from './CertificateView';
import { api, ApiError } from '../utils/api';
import { __resetModalStack } from '../utils/useModal';

/**
 * The certificate viewer, from the reader's side.
 *
 * ── What is worth pinning here ──
 *
 * Not that it renders. The failures that would actually reach a volunteer are
 * about the two controls: a download that silently does nothing, and a share
 * dialog that hands out the wrong link or asks somebody to select a URL by
 * hand. Both are the sort of thing that works in the developer's browser and
 * fails in a school Chromebook's — `navigator.share` absent, `navigator.
 * clipboard` refused on an insecure origin — so both fallbacks are driven here.
 *
 * Interaction is driven with `fireEvent` rather than `user-event`, matching the
 * rest of this suite — `@testing-library/user-event` is not a dependency of this
 * project and one control's tests are not a reason to add one.
 *
 * The third is refusal. The server answers 404 for "not yours" and "not real"
 * identically, on purpose, and this page must not guess between them: telling a
 * student "that certificate belongs to somebody else" about a code they mistyped
 * is both wrong and an unnecessary disclosure.
 */

const certificate = (overrides = {}) => ({
  code: 'WEV-4K2P-9QX7',
  title: 'Community Food Drive',
  location: 'South Brunswick High',
  hours: 6,
  startDatetime: '2026-05-14T14:00:00.000Z',
  endDatetime: '2026-05-14T20:00:00.000Z',
  organizerName: 'Dana Whitfield',
  organizerVerified: true,
  organizationName: 'Key Club',
  volunteer: { name: 'Leo Chen', grade: 11 },
  verifyUrl: 'https://wevolunteers.org/verify/WEV-4K2P-9QX7',
  verifyLabel: 'wevolunteers.org/verify/WEV-4K2P-9QX7',
  qr: 'data:image/png;base64,iVBORw0KGgo=',
  ...overrides,
});

const currentUser = { id: 'u1', name: 'Leo Chen', grade: 11 };

function renderViewer({ code = 'WEV-4K2P-9QX7', addToast = vi.fn() } = {}) {
  return {
    addToast,
    ...render(
      <MemoryRouter initialEntries={[`/certificates/${code}`]}>
        <Routes>
          <Route
            path="/certificates/:code"
            element={<CertificateView currentUser={currentUser} addToast={addToast} />}
          />
        </Routes>
      </MemoryRouter>,
    ),
  };
}

/**
 * A click, flushed.
 *
 * `fireEvent` is synchronous, and every control here starts state updates that
 * resolve on a microtask — an `await` inside `act` is what lets React settle
 * before the next assertion, and without it the failures are intermittent and
 * read as flaky rather than as missing.
 */
const click = (element) => act(async () => { fireEvent.click(element); });

beforeEach(() => { __resetModalStack(); });
afterEach(() => { vi.restoreAllMocks(); __resetModalStack(); });

describe('the document', () => {
  it('shows the certificate once it has loaded', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    renderViewer();

    expect(await screen.findByText('Certificate of Community Service')).toBeInTheDocument();
    /* The name appears twice by design — in the body and above the volunteer's
       own signature rule — so this asserts presence rather than uniqueness. */
    expect(screen.getAllByText('Leo Chen').length).toBeGreaterThan(0);
    expect(screen.getByText('WEV-4K2P-9QX7')).toBeInTheDocument();
    expect(screen.getByText(/Verify at/)).toBeInTheDocument();
  });

  it('shows the QR with an alt naming where it goes, not "QR code"', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    renderViewer();

    /* A screen-reader user cannot scan it and does not need to: the address is
       written out beside it as text, and the alt text points them at that. */
    const qr = await screen.findByRole('img', { name: /verify this certificate at/i });
    expect(qr).toHaveAttribute('src', expect.stringContaining('data:image/png'));
  });

  it('keeps the page chrome out of the printed document', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    const { container } = renderViewer();
    await screen.findByText('Certificate of Community Service');

    /* The print rule shows `.certificate` and its descendants and hides
       everything else, so anything that must not land on paper has to live
       outside that element. */
    const document_ = container.querySelector('.certificate');
    expect(within(document_).queryByRole('button')).toBeNull();
    expect(within(document_).queryByRole('link')).toBeNull();
  });

  /**
   * ── The event that was called off after the hours were confirmed ──
   *
   * Two things are true at once, and this page used to say neither. It carried
   * the certificate LIST's exclusion of a cancelled event, so the student named
   * on the document got "no such certificate" while the public verification
   * endpoint went on answering `valid` with the hours to anyone holding the
   * code. "There is no option to void a certificate" is a sentence in a
   * hash-pinned policy.
   *
   * So the document is shown — and the difference the reader will otherwise
   * notice on their own profile is explained rather than left to them.
   */
  it('explains a called-off event instead of hiding the certificate', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate({ eventCancelled: true }));
    renderViewer();
    await screen.findByText('Certificate of Community Service');

    expect(screen.getByText(/not counted in your service totals/i)).toBeInTheDocument();
  });

  it('says nothing of the sort for an ordinary certificate', async () => {
    /* The control. Without it this passes just as happily against a page that
       shows the notice to everybody. */
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    renderViewer();
    await screen.findByText('Certificate of Community Service');

    expect(screen.queryByText(/not counted in your service totals/i)).toBeNull();
  });

  it('keeps the explanation off the paper', async () => {
    /* It is context for the holder, not a mark on the document — the
       certificate is not void. Same rule as the chrome above. */
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate({ eventCancelled: true }));
    const { container } = renderViewer();
    await screen.findByText('Certificate of Community Service');

    const document_ = container.querySelector('.certificate');
    expect(within(document_).queryByText(/not counted in your service totals/i)).toBeNull();
    expect(screen.getByText(/not counted in your service totals/i).closest('.no-print'))
      .not.toBeNull();
  });
});

describe('when it cannot be opened', () => {
  it('does not guess between "not yours" and "no such code"', async () => {
    vi.spyOn(api, 'fetchCertificate').mockRejectedValue(new ApiError('nope', { status: 404 }));
    renderViewer();

    expect(await screen.findByText(/No certificate matches that code/i)).toBeInTheDocument();
    /* The server answers both identically on purpose — see the header of
       `server/routes/certificateRoutes.js`. A page that said "this belongs to
       somebody else" would both be wrong about a typo and disclose that the
       code is live. */
    expect(screen.queryByText(/belongs to/i)).toBeNull();
    expect(screen.getByRole('link', { name: /your certificates/i })).toBeInTheDocument();
  });

  it('separates a server fault from a missing certificate', async () => {
    vi.spyOn(api, 'fetchCertificate').mockRejectedValue(new ApiError('boom', { status: 500 }));
    renderViewer();
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });

  /**
   * The empty state is the only thing under the shell's `h1`, so an `h3` — the
   * `EmptyState` default, right for the twenty-eight callers that sit inside a
   * section — announces a level that is not there to anybody skimming by
   * heading. Reported by the accessibility sweep as `h1 "Certificate" -> h3`.
   */
  it('does not skip a heading level on the way to the empty state', async () => {
    vi.spyOn(api, 'fetchCertificate').mockRejectedValue(new ApiError('nope', { status: 404 }));
    renderViewer();

    const title = await screen.findByText(/No certificate matches that code/i);
    expect(title.tagName).toBe('H2');
  });

  /**
   * Why a view that is not an `ErrorExperience` carries its attribute.
   *
   * The a11y sweep uses `data-error-kind` to tell "I measured this route's page"
   * from "I measured an error panel standing in for it". Certificate codes are
   * random, so the harness's typed fixture never resolves and this route renders
   * the not-found panel on every run — which, unmarked, was measured and
   * reported as coverage of the certificate page.
   *
   * Asserted here because the attribute has no visible effect: nothing in the
   * product would fail if somebody removed it, and the sweep would quietly go
   * back to over-reporting.
   */
  it('marks the not-found panel so the a11y sweep does not count it as the page', async () => {
    vi.spyOn(api, 'fetchCertificate').mockRejectedValue(new ApiError('nope', { status: 404 }));
    const { container } = renderViewer();

    await screen.findByText(/No certificate matches that code/i);
    expect(container.querySelector('[data-error-kind="404"]')).not.toBeNull();
  });

  /* A server fault is not a 404, and marking it as one would make the sweep
     drop a route for the wrong reason. */
  it('does not mark a server fault as a missing page', async () => {
    vi.spyOn(api, 'fetchCertificate').mockRejectedValue(new ApiError('boom', { status: 500 }));
    const { container } = renderViewer();

    await screen.findByText(/could not be loaded/i);
    expect(container.querySelector('[data-error-kind="404"]')).toBeNull();
  });
});

describe('downloading', () => {
  /**
   * The save is driven through a real anchor click, so the assertions are about
   * what a browser would actually be handed.
   */
  function captureDownload() {
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => clicks.push({ href: el.href, download: el.download });
      return el;
    });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
    return clicks;
  }

  it('fetches the PDF and saves it, rather than navigating to it', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    const download = vi.spyOn(api, 'downloadCertificatePdf').mockResolvedValue(new Blob(['%PDF-']));
    const clicks = captureDownload();

    renderViewer();
    await screen.findByText('Certificate of Community Service');

    await click(screen.getByRole('button', { name: /download/i }));
    await click(await screen.findByRole('menuitem', { name: /download pdf/i }));

    await waitFor(() => expect(download).toHaveBeenCalledWith('WEV-4K2P-9QX7'));
    /* A blob URL, not the endpoint: navigating to the endpoint is answered by
       the browser's own PDF viewer on most desktops, which is the experience
       this whole feature exists to replace. */
    expect(clicks[0].href).toContain('blob:');
    expect(clicks[0].download).toContain('WEV-4K2P-9QX7');
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('reports a failed download without taking the reader off the page', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    vi.spyOn(api, 'downloadCertificatePdf').mockRejectedValue(new ApiError('no', { status: 500 }));
    const addToast = vi.fn();

    renderViewer({ addToast });
    await screen.findByText('Certificate of Community Service');

    await click(screen.getByRole('button', { name: /download/i }));
    await click(await screen.findByRole('menuitem', { name: /download pdf/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/could not be downloaded/i), 'error'));
    /* Still on the certificate. A navigation would have replaced it with a JSON
       error, losing the thing they came for in order to be told about a fault. */
    expect(screen.getByText('Certificate of Community Service')).toBeInTheDocument();
  });

  it('offers printing as well as a file, and nothing it cannot actually do', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    const print = vi.fn();
    vi.stubGlobal('print', print);

    renderViewer();
    await screen.findByText('Certificate of Community Service');
    await click(screen.getByRole('button', { name: /download/i }));

    const items = await screen.findAllByRole('menuitem');
    /* Exactly two. There is no image export, because there is no implementation
       that produces a correct certificate image — and a control that produces a
       wrong one is worse than an absent one. */
    expect(items.map(i => i.textContent)).toEqual(['Download PDF', 'Print']);

    await click(screen.getByRole('menuitem', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });
});

describe('sharing', () => {
  const openShare = async () => {
    await click(screen.getByRole('button', { name: /^share$/i }));
    return screen.findByRole('dialog', { name: /share this certificate/i });
  };

  it('shares the public verification link, never the viewer URL', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    renderViewer();
    await screen.findByText('Certificate of Community Service');

    const dialog = await openShare();
    const field = within(dialog).getByLabelText(/verification link/i);
    /* The viewer URL needs the owner's session and would 404 for the reader.
       The verification page is built for exactly this audience. */
    expect(field).toHaveValue('https://wevolunteers.org/verify/WEV-4K2P-9QX7');
    expect(field).toHaveAttribute('readonly');
  });

  it('copies the link and says so, without asking anyone to select text', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const addToast = vi.fn();

    renderViewer({ addToast });
    await screen.findByText('Certificate of Community Service');
    const dialog = await openShare();

    await click(within(dialog).getByRole('button', { name: /^copy$/i }));

    expect(writeText).toHaveBeenCalledWith('https://wevolunteers.org/verify/WEV-4K2P-9QX7');
    /* Both: a visible state for the person watching the button, and a polite
       live region for somebody who is not. */
    expect(await within(dialog).findByText('Link copied.')).toBeInTheDocument();
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/copied/i), 'success');
  });

  it('falls back when the clipboard API is refused, rather than doing nothing', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    /* An insecure origin, or a permissions policy. The modern API REJECTS in
       both cases, so without a catch the button silently does nothing. */
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    document.execCommand = vi.fn(() => true);
    const addToast = vi.fn();

    renderViewer({ addToast });
    await screen.findByText('Certificate of Community Service');
    const dialog = await openShare();
    await click(within(dialog).getByRole('button', { name: /^copy$/i }));

    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/copied/i), 'success');
  });

  it('offers the device share sheet when the browser has one', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share, clipboard: navigator.clipboard });

    renderViewer();
    await screen.findByText('Certificate of Community Service');
    const dialog = await openShare();

    await click(within(dialog).getByRole('button', { name: /share…/i }));

    const payload = share.mock.calls[0][0];
    expect(payload.url).toBe('https://wevolunteers.org/verify/WEV-4K2P-9QX7');
    /* The message names the achievement and never the person: it lands in the
       sharing app's history, the OS share log and a group chat's search index,
       and this platform's users are minors. */
    expect(payload.text).toMatch(/6 hrs/);
    expect(payload.text).not.toMatch(/Leo Chen/);
    expect(payload.text).not.toMatch(/South Brunswick/);
  });

  it('does not report a failure when somebody dismisses the share sheet', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('navigator', { ...navigator, share: vi.fn().mockRejectedValue(abort) });
    const addToast = vi.fn();

    renderViewer({ addToast });
    await screen.findByText('Certificate of Community Service');
    const dialog = await openShare();
    await click(within(dialog).getByRole('button', { name: /share…/i }));

    /* Changing your mind is not a failure, and a toast saying otherwise reads
       as the app being broken. */
    await waitFor(() => expect(addToast).not.toHaveBeenCalled());
  });

  it('offers per-platform links when the browser has no share sheet', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());
    /* `navigator.share` absent: every desktop Firefox, and Chrome outside a
       secure context. */
    vi.stubGlobal('navigator', { ...navigator, share: undefined });

    renderViewer();
    await screen.findByText('Certificate of Community Service');
    const dialog = await openShare();

    expect(within(dialog).queryByRole('button', { name: /share…/i })).toBeNull();

    for (const label of ['Email', 'WhatsApp', 'LinkedIn', 'Facebook']) {
      const link = within(dialog).getByRole('link', { name: new RegExp(label, 'i') });
      /* Without `noopener` the opened page holds `window.opener` and can
         navigate this tab — a reverse-tabnabbing phish aimed at somebody in the
         middle of proving their volunteering to a college. */
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
      expect(link.getAttribute('href')).toContain(
        label === 'Email' ? 'mailto:' : 'https://',
      );
    }
  });

  it('closes on Escape and returns focus to the control that opened it', async () => {
    vi.spyOn(api, 'fetchCertificate').mockResolvedValue(certificate());

    renderViewer();
    await screen.findByText('Certificate of Community Service');
    const trigger = screen.getByRole('button', { name: /^share$/i });

    /* Focused explicitly first: `fireEvent.click` does not move focus in jsdom,
       so without this the dialog opens with `body` as the previously-focused
       element and the restore has nothing to restore TO — which would make this
       case assert the opposite of the behaviour it is named for. */
    trigger.focus();
    await click(trigger);
    await screen.findByRole('dialog', { name: /share this certificate/i });

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    /* Otherwise the caret is dropped at the top of the document and a keyboard
       user has to walk the whole page again. */
    expect(document.activeElement).toBe(trigger);
  });
});
