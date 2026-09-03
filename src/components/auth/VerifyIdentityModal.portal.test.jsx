import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import VerifyIdentityModal from './VerifyIdentityModal';
import { api } from '../../utils/api';

/**
 * Where the verification dialog RENDERS, and why that is a correctness question.
 *
 * ── The incident ──
 *
 * The 2FA wall reported the password step as blank, dimmed and stuck. It was
 * neither blank nor stuck: it was off-screen.
 *
 * `.modal-overlay` is `position: fixed; inset: 0`, which means "the viewport"
 * only while no ancestor establishes a containing block for fixed descendants.
 * Two ancestors this dialog opens under do exactly that:
 *
 *   • `DeleteAccountModal` renders it inside its own `.modal-overlay`, which
 *     sets `backdrop-filter: blur(8px)`.
 *   • `TwoFactorRequiredWall` renders it inside `.auth`, which carries
 *     `animation: authFadeIn … forwards` — a fill-forwards animation whose last
 *     keyframe is `transform: translateY(0)`, so the computed transform never
 *     returns to `none`.
 *
 * `.auth` is `min-height: 100dvh` and grows with its content, so the overlay
 * sized itself to a box taller than the screen and centred the dialog below the
 * fold — while `useModal` had already set `body { overflow: hidden }`, so there
 * was no way to scroll to it.
 *
 * The dialog already carried `.modal-overlay-stacked`, and that class's own
 * docstring in index.css names the portal as its precondition: a z-index cannot
 * lift an element out of an ancestor's containing block. The class had been
 * applied without the portal it depends on, so it only ever darkened the
 * backdrop.
 *
 * jsdom performs no layout, so these assert the structural property instead:
 * nothing in the page is an ancestor of the overlay.
 */

const challenge = (over = {}) => ({
  challengeId: 'reauth-primary',
  action: '2fa.generate',
  label: 'set up two-factor authentication',
  methods: ['password'],
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  expiresInSeconds: 300,
  ...over
});

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('the dialog escapes its mount point', () => {
  it('portals the overlay to document.body', () => {
    const { container } = render(
      <VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />
    );

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.parentElement).toBe(document.body);
    expect(container.querySelector('.modal-overlay')).toBeNull();
  });

  /**
   * The specific arrangement that was broken: rendered inside an ancestor whose
   * transform makes it a containing block. Layout is not observable here, so the
   * assertion is that the dialog is not a descendant of that ancestor at all —
   * which is the only version of this that cannot be broken by a stylesheet.
   */
  it('is not a descendant of a transformed ancestor it is rendered inside', () => {
    const { container } = render(
      <div className="auth">
        <main className="auth-form">
          <VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />
        </main>
      </div>
    );

    const overlay = document.querySelector('.modal-overlay');
    expect(container.querySelector('.auth').contains(overlay)).toBe(false);
  });

  it('still declares its stacking level, for the case where it opens on a dialog', () => {
    render(<VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />);
    expect(document.querySelector('.modal-overlay').className).toMatch(/modal-overlay-stacked/);
  });
});

/**
 * A static guard, because the pairing is the part that got lost.
 *
 * `.modal-overlay-stacked` and `createPortal` are two halves of one decision and
 * were separated once already. A component that asks for the stacked overlay and
 * does not end up portalled is the same defect returning, and it renders
 * perfectly in every test that does not measure position.
 *
 * ── Why the scan follows delegation ──
 *
 * It used to require `createPortal(` in the SAME file, which was right while
 * every stacked overlay was hand-rolled. It stopped being right the moment one
 * was reached through a component: `ShareOrganizationDialog` passes
 * `overlayClassName` to `ConfirmDialog`, which passes it to `Modal`, which
 * portals — the property this guard exists for is satisfied, by construction and
 * for every future caller, and the file names no `createPortal` at all.
 *
 * Failing that file would have taught the next person to inline a portal beside
 * a shared dialog, or to delete the class. So the scan asks the question it
 * means: does this overlay end up in a portal? A file satisfies it by portalling
 * itself, or by handing the class to a component that does — and the shells that
 * qualify are ASSERTED to portal below, so the delegation cannot become a
 * loophole by one of them dropping its `createPortal`.
 */
describe('every stacked overlay is portalled', () => {
  const SRC = path.join(process.cwd(), 'src');

  /**
   * The dialog shells a caller may delegate to.
   *
   * Closed and small on purpose. Each is verified to portal in the test below,
   * so adding one is a deliberate act that fails until the component really does
   * put its overlay in a portal.
   */
  const PORTALLING_SHELLS = {
    'components/Modal.jsx': 'Modal',
    'components/common/ConfirmDialog.jsx': 'ConfirmDialog',
  };

  it('keeps every shell a caller may delegate to actually portalling', () => {
    for (const [file, name] of Object.entries(PORTALLING_SHELLS)) {
      const src = readFileSync(path.join(SRC, file), 'utf8');
      /* Either it portals itself (Modal), or it renders one that does
         (ConfirmDialog renders Modal). Both are the same guarantee to a caller. */
      const portals = /createPortal\s*\(/.test(src) || /<Modal[\s>]/.test(src);
      expect(portals, `${name} no longer portals, so every caller that delegated to it is now trapped`).toBe(true);
      /* And it still passes the class through — a shell that swallowed
         `overlayClassName` would leave the caller's stacking silently unapplied. */
      expect(src, `${name} no longer forwards overlayClassName`).toMatch(/overlayClassName/);
    }
  });

  it('has no component asking for .modal-overlay-stacked without ending up in a portal', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        // The className usage, not a mention in a comment explaining the bug.
        if (!/overlayClassName=["']modal-overlay-stacked["']/.test(src)) continue;
        if (/createPortal\s*\(/.test(src)) continue;
        /* Delegated to a shell that portals — the same guarantee, reached
           through a component rather than written out. */
        const delegates = Object.values(PORTALLING_SHELLS)
          .some(name => new RegExp(`<${name}[\\s>]`).test(src));
        if (!delegates) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(SRC);
    expect(
      offenders,
      'a stacked overlay that is not portalled is still trapped by any ancestor '
      + 'with a transform, filter or backdrop-filter — the z-index does nothing. '
      + 'Portal it, or render it through Modal or ConfirmDialog.'
    ).toEqual([]);
  });
});
