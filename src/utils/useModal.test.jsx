import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import Modal from '../components/Modal';

/**
 * Regression cover for stacked dialogs.
 *
 * The schedule-conflict warning opens on top of the event modal. Both dialogs
 * bind their Escape handler to `document`, and `stopPropagation` does not stop
 * other listeners on the SAME node — so a single Escape ran both handlers and
 * closed the conflict warning together with the modal behind it. Reproduced in a
 * browser: after one Escape, zero overlays remained where one should have.
 *
 * `stopImmediatePropagation` would not have fixed it either: listeners fire in
 * registration order, so the dialog UNDERNEATH would have won the event.
 *
 * The second half is scroll lock. Each dialog saves `body.style.overflow` on
 * mount, so a stacked dialog saves the 'hidden' the first one already set, and
 * on close writes 'hidden' back — leaving the page unscrollable while the outer
 * modal was still open.
 */

function TwoModals({ onCloseOuter, onCloseInner, showInner }) {
  return (
    <>
      <Modal onClose={onCloseOuter} label="Outer">
        <button>outer control</button>
      </Modal>
      {showInner && (
        <Modal onClose={onCloseInner} label="Inner" overlayClassName="modal-overlay-stacked">
          <button>inner control</button>
        </Modal>
      )}
    </>
  );
}

describe('Escape with one dialog open', () => {
  it('closes it', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} label="Only"><button>x</button></Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Escape with a dialog stacked on another', () => {
  it('closes only the top one', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(<TwoModals onCloseOuter={onCloseOuter} onCloseInner={onCloseInner} showInner />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter, 'the dialog underneath must stay open').not.toHaveBeenCalled();
  });

  it('lets the dialog underneath respond once the top one has gone', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    const { rerender } = render(
      <TwoModals onCloseOuter={onCloseOuter} onCloseInner={onCloseInner} showInner />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseInner).toHaveBeenCalledTimes(1);

    // The inner dialog unmounts, as it would after its onClose ran.
    rerender(<TwoModals onCloseOuter={onCloseOuter} onCloseInner={onCloseInner} showInner={false} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseOuter).toHaveBeenCalledTimes(1);
    expect(onCloseInner).toHaveBeenCalledTimes(1);
  });

  it('needs one Escape per dialog rather than collapsing the whole stack', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(<TwoModals onCloseOuter={onCloseOuter} onCloseInner={onCloseInner} showInner />);

    // Three presses without the inner dialog unmounting (its parent decides
    // that) must still only ever address the top of the stack.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCloseInner).toHaveBeenCalledTimes(3);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it('ignores keys other than Escape and Tab', () => {
    const onCloseInner = vi.fn();
    render(<TwoModals onCloseOuter={vi.fn()} onCloseInner={onCloseInner} showInner />);
    fireEvent.keyDown(document, { key: 'a' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onCloseInner).not.toHaveBeenCalled();
  });

  /*
   * Initial focus placement is deliberately NOT asserted here: useModal filters
   * candidates by `offsetParent !== null`, and jsdom performs no layout so that
   * is always null — the filter yields nothing regardless of correctness.
   * Verified in a real browser instead: opening the conflict dialog reported
   * focusInsideDialog true, activeElement "Keep my current shift".
   */
});

describe('scroll lock across stacked dialogs', () => {
  it('locks while any dialog is open and restores only at the end', () => {
    document.body.style.overflow = '';
    const { rerender, unmount } = render(
      <TwoModals onCloseOuter={vi.fn()} onCloseInner={vi.fn()} showInner />
    );
    expect(document.body.style.overflow).toBe('hidden');

    // Close the top dialog: the page must stay locked, the outer one is still up.
    rerender(<TwoModals onCloseOuter={vi.fn()} onCloseInner={vi.fn()} showInner={false} />);
    expect(document.body.style.overflow, 'still locked behind the outer dialog').toBe('hidden');

    unmount();
    expect(document.body.style.overflow, 'restored once nothing is open').toBe('');
  });
});
