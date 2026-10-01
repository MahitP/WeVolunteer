import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SuspendedWall from './SuspendedWall';
import { api } from '../../utils/api';

vi.mock('../../utils/api');

/**
 * The screen a suspended account sees instead of the application.
 *
 * ── What this file is NOT responsible for ──
 *
 * Whether a suspended account can reach anything. It cannot, and that is decided
 * in `authenticateToken` against `suspendedAccess.js`, proved by
 * `server/suspendedSession.test.js`. If this component were deleted the account
 * would still be locked out — it would just not be told why.
 *
 * What is tested here is the telling: that the reason survives, that an
 * indefinite suspension is not silently read as a short one, and that the appeal
 * the Community Guidelines promise is actually reachable from the only screen
 * this person can open.
 */

const SUSPENSION = (over = {}) => ({
  reason: 'Messaging a student after being asked to stop',
  since: '2026-08-01T09:00:00.000Z',
  until: null,
  indefinite: true,
  ...over,
});

const USER = { id: 'user-student-2', email: 'priya.patel@example.com', name: 'Priya Patel' };

const renderWall = (over = {}) => render(
  <SuspendedWall
    user={USER}
    suspension={SUSPENSION(over.suspension)}
    onSignOut={over.onSignOut ?? vi.fn()}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  api.listMyAppeals.mockResolvedValue({ appeals: [] });
  api.submitAppeal.mockResolvedValue({ id: 'appeal-1' });
});

describe('SuspendedWall', () => {
  it('says plainly what has happened', async () => {
    renderWall();
    expect(screen.getByRole('heading', { name: /your account is suspended/i })).toBeInTheDocument();
  });

  /**
   * The reason is shown verbatim. An administrator had to write at least 24
   * characters of it, and the whole point of that floor is that the person is
   * shown something they can contest rather than a category name.
   */
  it('shows the reason the administrator wrote, word for word', async () => {
    renderWall();
    expect(
      screen.getByText('Messaging a student after being asked to stop')
    ).toBeInTheDocument();
  });

  /**
   * The misreading this costs one boolean to avoid.
   *
   * A missing end date rendered as nothing, or as an empty "Ends on", reads as
   * "ends soon" to somebody who badly wants that to be true. `indefinite` is
   * carried as its own field precisely so this screen never has to guess.
   */
  it('says an indefinite suspension has no end date, rather than showing nothing', () => {
    renderWall();
    expect(screen.getByText(/no end date/i)).toBeInTheDocument();
    expect(screen.queryByText(/ends on/i)).not.toBeInTheDocument();
  });

  it('names the end date when there is one', () => {
    renderWall({ suspension: { until: '2026-09-01T00:00:00.000Z', indefinite: false } });
    expect(screen.getByText(/ends on/i)).toBeInTheDocument();
    expect(screen.queryByText(/no end date/i)).not.toBeInTheDocument();
  });

  /* ── The way out, and the way to contest it ───────────────────────────── */

  it('offers a sign-out that actually calls back', () => {
    const onSignOut = vi.fn();
    renderWall({ onSignOut });
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it('lets the person appeal from the only screen they can open', async () => {
    renderWall();
    const box = await screen.findByLabelText(/what happened, in your own words/i);

    fireEvent.change(box, {
      target: { value: 'I was replying to a question they asked me in the group chat first.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send my appeal/i }));

    await waitFor(() => expect(api.submitAppeal).toHaveBeenCalledWith({
      subject: 'suspension',
      statement: 'I was replying to a question they asked me in the group chat first.',
    }));
  });

  /**
   * The server refuses a statement under 40 characters with a 400. Letting the
   * button submit anyway would spend a round trip to tell somebody something the
   * form already knew, on the screen where they are least able to absorb another
   * refusal.
   */
  it('does not let an empty or too-short appeal be sent', async () => {
    renderWall();
    await screen.findByLabelText(/what happened, in your own words/i);
    const send = screen.getByRole('button', { name: /send my appeal/i });

    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/what happened, in your own words/i), {
      target: { value: 'unfair' },
    });
    expect(send).toBeDisabled();
  });

  it('does not offer a second appeal while one is open', async () => {
    api.listMyAppeals.mockResolvedValue({
      appeals: [{ id: 'a1', status: 'open', statement: 'x' }],
    });
    renderWall();

    expect(await screen.findByText(/your appeal is with us/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send my appeal/i })).not.toBeInTheDocument();
  });

  it('shows the outcome once an appeal has been decided', async () => {
    api.listMyAppeals.mockResolvedValue({
      appeals: [{
        id: 'a1', status: 'resolved', decision: 'stands',
        reasoning: 'The messages continued after a clear request to stop.',
        reviewerName: 'a WeVolunteer administrator',
      }],
    });
    renderWall();
    expect(
      await screen.findByText(/the messages continued after a clear request to stop/i)
    ).toBeInTheDocument();
  });

  /**
   * The explanation is the part that has to survive.
   *
   * `/api/appeals/mine` is one of only four routes this session can reach, and if
   * it fails the reason must still be on screen — losing the whole page because
   * a secondary fetch broke would put the person back exactly where this feature
   * found them.
   */
  it('still shows the reason when the appeal list will not load', async () => {
    api.listMyAppeals.mockRejectedValue(new Error('network'));
    renderWall();

    expect(
      await screen.findByText('Messaging a student after being asked to stop')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});

/**
 * The owner's look, without the live app behind it (ruling 1).
 *
 * He asked for a splash screen "with a like red boarder or smth blurred
 * background app" (FX-03). The first attempt rendered the real shell under a
 * blurred, inert overlay, and it was reverted for three reasons recorded in
 * App.jsx: it moved the suspension check below the verification wall, `blur()`
 * on the shell broke every fixed-position toast and modal, and it mounted the
 * whole authenticated app for an account the server answers on four routes.
 *
 * So the backdrop is a silhouette: a few empty blocks shaped like the app,
 * blurred, decorative, and holding nothing — no data, no text, no controls.
 */
describe('the wall\'s look (ruling 1)', () => {
  it('sits over a decorative backdrop that carries nothing', async () => {
    const { container } = renderWall();
    const backdrop = container.querySelector('.suspended-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(backdrop.textContent.trim()).toBe('');
    expect(backdrop.querySelectorAll('a, button, input, textarea, select, [tabindex]')).toHaveLength(0);
  });

  it('has a red border around the wall itself', () => {
    const { container } = renderWall();
    expect(container.querySelector('main.suspended-card')).not.toBeNull();
  });

  it('blurs the backdrop only, and nothing fixed lives inside it', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const card = /\.suspended-card\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(card).toMatch(/border:\s*2px solid var\(--danger\)/);
    const backdrop = /\.suspended-backdrop\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(backdrop).toMatch(/filter:\s*blur\(/);
    expect(backdrop).toMatch(/pointer-events:\s*none/);
    /* The blur is on the backdrop, never on the screen that holds the wall —
       that is the containing-block trap the reverted version fell into. */
    expect(css).not.toMatch(/\.suspended-screen\s*\{[^}]*filter:/);
  });
});
