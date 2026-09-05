import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LegalAcceptanceModal from './LegalAcceptanceModal';
import { __resetModalStack } from '../../utils/useModal';

/**
 * The dialog somebody cannot get past without answering.
 *
 * ── What is being protected ──
 *
 * `aria-modal="true"` is a promise to assistive technology that nothing outside
 * the dialog is reachable, and the APG is blunt that a dialog which claims it
 * without behaving that way has "severe negative ramifications" — the reader is
 * cut off from content that is still, for everybody else, interactive.
 *
 * This dialog additionally withholds Escape, which the same pattern lists as
 * required. That is a deliberate exception and it is only defensible while the
 * two real answers stay operable from the keyboard and stay named in the
 * dialog's own text. Those are the assertions below; if one of them ever fails,
 * the exception has become a keyboard trap.
 */

const REQUIRED = {
  slug: 'terms-of-service',
  title: 'Terms of Service',
  version: '2.0.0',
  previousVersion: '1.0',
  effectiveAt: '2026-09-01',
  severity: 'material',
  channel: 'acceptance',
  requiresAcceptance: true,
  excerpt: 'We may now share your attendance record with your school district.',
  changeCount: 1,
  isSample: false,
};

const draw = (required = [REQUIRED], over = {}) => {
  const onAccepted = over.onAccepted ?? vi.fn().mockResolvedValue(undefined);
  const onSignOut = over.onSignOut ?? vi.fn();
  return {
    onAccepted,
    onSignOut,
    ...render(
      <LegalAcceptanceModal required={required} onAccepted={onAccepted} onSignOut={onSignOut} />
    ),
  };
};

beforeEach(() => { __resetModalStack(); vi.clearAllMocks(); });
afterEach(() => __resetModalStack());

describe('dialog semantics', () => {
  it('is an alertdialog, because it interrupts to get an answer', () => {
    /* `role="dialog"` would tell a screen reader this is a panel somebody
       opened. The alertdialog role is what lets it be treated as the
       interruption it is. */
    const { baseElement } = draw();
    const dialog = baseElement.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('is named by its own heading rather than by a copy of it', () => {
    const { baseElement } = draw();
    const dialog = baseElement.querySelector('[role="alertdialog"]');
    const labelId = dialog.getAttribute('aria-labelledby');

    expect(labelId, 'aria-labelledby, not a duplicated aria-label').toBeTruthy();
    expect(dialog.getAttribute('aria-label')).toBeNull();
    expect(baseElement.querySelector(`#${labelId}`).textContent)
      .toMatch(/Please accept the updated Terms of Service/);
  });

  it('describes itself, which the alertdialog pattern requires', () => {
    const { baseElement } = draw();
    const dialog = baseElement.querySelector('[role="alertdialog"]');
    const describedId = dialog.getAttribute('aria-describedby');

    expect(describedId).toBeTruthy();
    expect(baseElement.querySelector(`#${describedId}`).textContent)
      .toMatch(/we need your agreement/i);
  });

  it('moves focus into the dialog when it opens', () => {
    const { baseElement } = draw();
    const dialog = baseElement.querySelector('[role="alertdialog"]');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  /**
   * On the heading, and not on the first button.
   *
   * `useModal`'s default is the first control that is not a close button, which
   * here is "Sign out" — so arriving by keyboard and pressing Space, which is
   * what people do, signed somebody out of a dialog that had just asked them to
   * read something. Focusing "Accept" instead would arm agreeing to a document
   * nobody has read. A heading arms nothing, and it is what the APG suggests
   * for a dialog whose content should be read from the beginning.
   */
  it('arms nothing: focus lands on the heading, not on an action', () => {
    draw();
    expect(document.activeElement.tagName).toBe('H2');
    expect(document.activeElement.textContent).toMatch(/Please accept the updated/);
  });

  it('keeps the heading out of the tab cycle', () => {
    /* Programmatically focusable, not tabbable — otherwise Tab would cycle
       through a heading on the way round. */
    draw();
    expect(document.activeElement.getAttribute('tabindex')).toBe('-1');
  });

  it('locks the page behind it', () => {
    draw();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('offers no close control', () => {
    /* An X that puts the same dialog straight back is a control that appears
       broken. The two answers are in the footer. */
    const { baseElement } = draw();
    expect(baseElement.querySelector('.modal-close')).toBeNull();
  });
});

describe('it cannot be waved away', () => {
  it('ignores Escape', () => {
    const { baseElement } = draw();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(baseElement.querySelector('[role="alertdialog"]')).toBeTruthy();
  });

  it('ignores a click on the backdrop', () => {
    const { baseElement } = draw();
    fireEvent.click(baseElement.querySelector('.modal-overlay'));
    expect(baseElement.querySelector('[role="alertdialog"]')).toBeTruthy();
  });

  /**
   * The other half of withholding Escape: both ways out have to be reachable
   * without a mouse, or the exception is a keyboard trap under WCAG 2.1.2.
   */
  it('keeps every action in the tab sequence', () => {
    const { baseElement } = draw();
    const dialog = baseElement.querySelector('[role="alertdialog"]');
    const focusable = [...dialog.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )];

    const names = focusable.map(el => el.textContent);
    expect(names.some(n => /Accept and continue/.test(n))).toBe(true);
    expect(names.some(n => /Sign out/.test(n))).toBe(true);
    expect(names.some(n => /Read the document/.test(n))).toBe(true);
  });

  it('names both ways out in its own text', () => {
    draw();
    expect(screen.getByText(/you can sign out/i)).toBeInTheDocument();
  });
});

describe('reading the document', () => {
  it('links to the canonical route, in a new tab, and says so', () => {
    /**
     * `/legal/:slug` is a PUBLIC route and `App.jsx` answers a public path
     * BEFORE it builds the signed-in shell, so a same-tab navigation replaces
     * the whole application — this dialog included. A new tab is what lets
     * somebody read and come back to the question they were in the middle of.
     */
    draw();
    const link = screen.getByRole('link', { name: /Read the document/i });
    expect(link.getAttribute('href')).toBe('/legal/terms-of-service');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link.textContent).toMatch(/opens in a new tab/i);
  });
});

describe('what it shows about the change', () => {
  it('quotes a sentence that is genuinely new', () => {
    draw();
    expect(screen.getByText(/school district/)).toBeInTheDocument();
  });

  it('says the quote is one of several when it is', () => {
    /* The excerpt cannot know which change matters most; presenting one as
       "what changed" would overstate it. */
    draw([{ ...REQUIRED, changeCount: 4, isSample: true }]);
    expect(screen.getByText(/one of 4 changes/)).toBeInTheDocument();
  });

  it('does not invent a quote when nothing quotable was added', () => {
    const { baseElement } = draw([{ ...REQUIRED, excerpt: null, changeCount: 0 }]);
    expect(screen.getByText(/wording has been revised/i)).toBeInTheDocument();
    expect(baseElement.querySelector('.legal-excerpt')).toBeNull();
  });

  it('states the version, the effective date and what they last accepted', () => {
    draw();
    const line = screen.getByText(/Version 2\.0\.0/);
    expect(line.textContent).toMatch(/in effect from/i);
    expect(line.textContent).toMatch(/you last accepted 1\.0/);
  });
});

describe('accepting', () => {
  it('records the acceptance for the document on screen', async () => {
    const { onAccepted } = draw();
    fireEvent.click(screen.getByRole('button', { name: /Accept and continue/i }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onAccepted.mock.calls[0][0]).toMatchObject({ slug: 'terms-of-service', version: '2.0.0' });
  });

  it('closes once the last document is accepted', async () => {
    /* Closing is the parent shortening the list to nothing, not the dialog
       deciding it is finished — see the note on `current`. */
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    const { baseElement, rerender } = draw([REQUIRED], { onAccepted });

    fireEvent.click(screen.getByRole('button', { name: /Accept and continue/i }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());

    rerender(<LegalAcceptanceModal required={[]} onAccepted={onAccepted} onSignOut={vi.fn()} />);
    expect(baseElement.querySelector('[role="alertdialog"]')).toBeNull();
  });

  /**
   * Unlike the ordinary banner, a failure here has to be said out loud.
   *
   * Somebody who pressed Accept and got nothing has no way to tell whether
   * their agreement was recorded, and the capabilities are still withheld on
   * the next request.
   */
  it('reports a failure instead of pretending it worked', async () => {
    const onAccepted = vi.fn().mockRejectedValue({ data: { error: 'Database unavailable.' } });
    const { baseElement } = draw([REQUIRED], { onAccepted });

    fireEvent.click(screen.getByRole('button', { name: /Accept and continue/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Database unavailable/);
    expect(baseElement.querySelector('[role="alertdialog"]'), 'and it stays open').toBeTruthy();
    expect(screen.getByRole('button', { name: /Accept and continue/i })).not.toBeDisabled();
  });
});

describe('signing out instead', () => {
  it('is one press, and does not record an acceptance', () => {
    const { onSignOut, onAccepted } = draw();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

describe('several documents needing acceptance', () => {
  const SECOND = { ...REQUIRED, slug: 'community-guidelines', title: 'Community Guidelines' };

  it('shows one dialog, not a stack', () => {
    const { baseElement } = draw([REQUIRED, SECOND]);
    expect(baseElement.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
  });

  it('says how many are left, so nobody thinks they are finished', () => {
    /* Beside the version rather than in the footer: at the dialog's 560px the
       count wrapped onto three lines there and squeezed the three actions into
       the right half. */
    draw([REQUIRED, SECOND]);
    expect(screen.getByText(/1 more after this/i)).toBeInTheDocument();
  });

  it('says whether pressing accept finishes the job', () => {
    /* "Accept and continue" three times in a row, each putting another dialog
       up, reads as a loop rather than as progress. */
    draw([REQUIRED, SECOND]);
    expect(screen.getByRole('button', { name: 'Accept and go on' })).toBeInTheDocument();
  });

  it('advances to the next after the first is accepted', async () => {
    /**
     * Driven by the LIST, not by a cursor into it.
     *
     * The dialog holds no index: it renders `required[0]`, and the parent
     * re-reads the pending list after each acceptance so the accepted document
     * has left it. An earlier version incremented a local index instead, and
     * whether the reader saw the next document or an empty screen depended on
     * which state update React flushed first — with the account still gated and
     * nothing on screen saying why. So the caller here does what the real one
     * does: shortens the list.
     */
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    const { rerender } = draw([REQUIRED, SECOND], { onAccepted });

    fireEvent.click(screen.getByRole('button', { name: /Accept and go on/i }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());

    rerender(
      <LegalAcceptanceModal required={[SECOND]} onAccepted={onAccepted} onSignOut={vi.fn()} />
    );
    expect(await screen.findByText(/Please accept the updated Community Guidelines/))
      .toBeInTheDocument();
    expect(screen.queryByText(/more after this/i), 'the last one has nothing after it').toBeNull();
  });

  it('accepts them one at a time rather than in one act', async () => {
    /* One button recording agreement to two documents somebody may feel
       differently about is a weaker record than two. */
    const { onAccepted } = draw([REQUIRED, SECOND]);
    fireEvent.click(screen.getByRole('button', { name: /Accept and go on/i }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onAccepted.mock.calls[0][0].slug).toBe('terms-of-service');
  });
});

describe('renders nothing', () => {
  it('when nothing is required', () => {
    const { baseElement } = draw([]);
    expect(baseElement.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
