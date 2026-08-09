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
 * were separated once already. A component that asks for the stacked overlay
 * without portalling is the same defect returning, and it renders perfectly in
 * every test that does not measure position.
 */
describe('every stacked overlay is portalled', () => {
  it('has no component asking for .modal-overlay-stacked without createPortal', () => {
    const SRC = path.join(process.cwd(), 'src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        // The className usage, not a mention in a comment explaining the bug.
        if (!/overlayClassName=["']modal-overlay-stacked["']/.test(src)) continue;
        if (!/createPortal\s*\(/.test(src)) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(SRC);
    expect(
      offenders,
      'a stacked overlay that is not portalled is still trapped by any ancestor '
      + 'with a transform, filter or backdrop-filter — the z-index does nothing'
    ).toEqual([]);
  });
});

/**
 * One password entry answering several challenges.
 *
 * The two halves of authenticator enrolment are separate registered actions
 * (`2fa.generate`, `2fa.enable`), so they need separate grants — but prompting
 * twice put the second prompt after a 30-second TOTP code had been typed. Each
 * challenge is still opened, bound and verified independently; what is shared is
 * the answer, to one question, about one operation.
 */
describe('granting more than one challenge from one answer', () => {
  it('grants the primary first, then each extra, and reports which succeeded', async () => {
    const grant = vi.spyOn(api, 'grantReauthByPassword').mockResolvedValue({ granted: true });
    const onGranted = vi.fn();

    render(
      <VerifyIdentityModal
        challenge={challenge()}
        alsoGrant={[{ action: '2fa.enable', challengeId: 'reauth-extra' }]}
        onGranted={onGranted}
        onCancel={() => {}}
      />
    );

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(onGranted).toHaveBeenCalled());

    expect(grant.mock.calls).toEqual([
      ['reauth-primary', 'pw'],
      ['reauth-extra', 'pw']
    ]);
    expect(onGranted).toHaveBeenCalledWith('reauth-primary', { '2fa.enable': 'reauth-extra' });
  });

  /**
   * A wrong password must cost ONE failed attempt, not one per challenge.
   * `reauthLimiter` allows five failures per fifteen minutes per IP.
   */
  it('does not touch the extras when the password is wrong', async () => {
    const err = Object.assign(new Error('That password is not right.'), {
      status: 401,
      data: { error: 'That password is not right.', attemptsRemaining: 4 }
    });
    const grant = vi.spyOn(api, 'grantReauthByPassword').mockRejectedValue(err);
    const onGranted = vi.fn();

    render(
      <VerifyIdentityModal
        challenge={challenge()}
        alsoGrant={[{ action: '2fa.enable', challengeId: 'reauth-extra' }]}
        onGranted={onGranted}
        onCancel={() => {}}
      />
    );

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/not right/);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(onGranted).not.toHaveBeenCalled();
    // The dialog stays open: the challenge still has attempts left.
    expect(screen.getByLabelText(/your password/i)).toBeTruthy();
  });

  /**
   * An extra that cannot be granted is not fatal. The primary grant is real and
   * the caller falls back to an ordinary step-up for whatever is missing;
   * failing the dialog would throw away a verification just earned.
   */
  it('reports the primary even when an extra is refused', async () => {
    vi.spyOn(api, 'grantReauthByPassword').mockImplementation(async (id) => {
      if (id === 'reauth-extra') throw new Error('expired');
      return { granted: true };
    });
    const onGranted = vi.fn();

    render(
      <VerifyIdentityModal
        challenge={challenge()}
        alsoGrant={[{ action: '2fa.enable', challengeId: 'reauth-extra' }]}
        onGranted={onGranted}
        onCancel={() => {}}
      />
    );

    fireEvent.change(screen.getByLabelText(/your password/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(onGranted).toHaveBeenCalledWith('reauth-primary', {}));
  });
});

describe('why the password is being asked for', () => {
  it('names the operation the grant will be spent on', () => {
    render(<VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/You asked to set up two-factor authentication/i);
    expect(dialog.textContent).toMatch(/we need your password/i);
  });

  it('describes the field to a screen reader and marks it invalid after a refusal', async () => {
    vi.spyOn(api, 'grantReauthByPassword').mockRejectedValue(
      Object.assign(new Error('no'), { status: 401, data: { error: 'no' } })
    );
    render(<VerifyIdentityModal challenge={challenge()} onGranted={() => {}} onCancel={() => {}} />);

    const field = screen.getByLabelText(/your password/i);
    expect(field.getAttribute('aria-describedby')).toBe('reauth-why');
    expect(document.getElementById('reauth-why')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(
      screen.getByLabelText(/your password/i).getAttribute('aria-invalid')
    ).toBe('true'));
  });
});
