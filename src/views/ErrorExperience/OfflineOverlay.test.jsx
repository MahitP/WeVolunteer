/**
 * Losing the connection must not lose what somebody typed.
 *
 * ── The defect this exists to prevent ──
 *
 * The first wiring of `useOnline` chose between the offline experience and the
 * routed view with a ternary: `!online ? <ErrorExperience/> : <Routes/>`. That
 * reads as a display decision and is really a destruction: React unmounts the
 * whole routed subtree, and every piece of component state inside it — a
 * half-written signup form, a partly-filled event description — is gone. It was
 * measured in a browser, not theorised: typing a name into `/signup`, firing a
 * synthetic `offline`, then `online`, gave the field back EMPTY.
 *
 * The offline copy says "anything you haven't sent is still on this device".
 * The app was the thing making that false.
 *
 * A dropped bar on a school bus lasts seconds. It must cost nothing.
 */
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OfflineOverlay from './OfflineOverlay';

/** Stands in for any routed view holding unsaved local state. */
function Draft() {
  const [text, setText] = useState('');
  return (
    <label>
      Draft
      <input value={text} onChange={(e) => setText(e.target.value)} />
    </label>
  );
}

const at = (online) =>
  render(
    <MemoryRouter>
      <OfflineOverlay online={online}><Draft /></OfflineOverlay>
    </MemoryRouter>
  );

describe('the app survives the connection dropping', () => {
  it('keeps unsaved input across an offline/online round trip', () => {
    const view = at(true);
    fireEvent.change(screen.getByLabelText(/draft/i), { target: { value: 'Jordan Alvarez' } });

    const offline = (
      <MemoryRouter>
        <OfflineOverlay online={false}><Draft /></OfflineOverlay>
      </MemoryRouter>
    );
    view.rerender(offline);
    expect(screen.getByRole('alert').dataset.errorKind).toBe('offline');

    view.rerender(
      <MemoryRouter>
        <OfflineOverlay online><Draft /></OfflineOverlay>
      </MemoryRouter>
    );

    // The whole point. A ternary between the experience and the children fails
    // here with '' — which is what shipped before this test existed.
    expect(screen.getByLabelText(/draft/i)).toHaveValue('Jordan Alvarez');
  });

  it('recovers with no interaction, which is the promise its own copy makes', () => {
    const view = at(false);
    expect(screen.queryByRole('alert')).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <OfflineOverlay online><Draft /></OfflineOverlay>
      </MemoryRouter>
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the covered app is unreachable while it is covered', () => {
  it('hides the app beneath from assistive technology and from the tab order', () => {
    const { container } = at(false);
    const under = container.querySelector('.err-offline-under');

    expect(under, 'no wrapper — the children cannot be made inert').toBeTruthy();
    expect(under.getAttribute('aria-hidden')).toBe('true');
    // `inert` is what stops a keyboard reaching a form that cannot submit.
    // aria-hidden alone leaves it tabbable, which is the worse half of the bug.
    expect(under.hasAttribute('inert')).toBe(true);
  });

  it('leaves the app fully reachable again once the connection returns', () => {
    const { container } = at(true);
    const under = container.querySelector('.err-offline-under');
    expect(under).toBeTruthy();
    expect(under.hasAttribute('inert')).toBe(false);
    expect(under.hasAttribute('aria-hidden')).toBe(false);
  });

  /**
   * The wrapper has to exist in BOTH states. An element that appears only when
   * offline changes the tree shape at that position, so React unmounts the
   * children — reintroducing the exact defect above by a different route.
   */
  it('wraps the children identically whether online or offline', () => {
    const on = at(true).container.querySelector('.err-offline-under');
    const off = at(false).container.querySelector('.err-offline-under');
    expect(on.tagName).toBe(off.tagName);
    expect(on.className).toBe(off.className);
  });
});
