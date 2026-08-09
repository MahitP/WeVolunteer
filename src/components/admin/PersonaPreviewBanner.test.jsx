import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PersonaPreviewBanner from './PersonaPreviewBanner';
import { can } from '../../authz';
import { api } from '../../utils/api';

/**
 * The way out of a persona preview.
 *
 * ── Why this component is worth its own tests ──
 *
 * A preview NARROWS the owner's capabilities, so the pages that would naturally
 * host a control for it are the first ones it takes away: an owner previewing as
 * a student loses `report.resolve` and with it the Moderation Center, which is
 * where the preview was started. This banner is the only thing standing between
 * that and an owner who is convinced the platform has broken.
 *
 * So the cases below are mostly about it being PRESENT — on every page, for every
 * persona, and not quietly conditioned on something the preview has removed.
 *
 * The server-side guarantees are in `server/personaPreview.test.js`. Nothing here
 * is a security assertion: this component cannot grant anything, and the client's
 * `can()` narrowing tested at the bottom is a UX mirror that the server re-checks
 * on every request.
 */

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const PREVIEW = { persona: 'student', expiresAt: new Date(Date.now() + 60000).toISOString() };

describe('PersonaPreviewBanner', () => {
  it('renders nothing when no preview is in force', () => {
    const { container } = render(<PersonaPreviewBanner preview={null} onEnded={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  /** A payload predating the field, or a half-written one, is not a preview. */
  it.each([undefined, {}, { persona: null }, { persona: '' }])(
    'renders nothing for %s', (preview) => {
      const { container } = render(<PersonaPreviewBanner preview={preview} onEnded={() => {}} />);
      expect(container).toBeEmptyDOMElement();
    });

  it('names the persona and offers a way out', () => {
    render(<PersonaPreviewBanner preview={PREVIEW} onEnded={() => {}} />);

    expect(screen.getByRole('status').textContent).toMatch(/previewing/i);
    expect(screen.getByRole('status').textContent).toMatch(/student/);
    expect(screen.getByRole('button', { name: /stop previewing/i })).toBeTruthy();
  });

  /**
   * It says that access is REDUCED, in so many words.
   *
   * Without that sentence the banner explains a cosmetic change, and an owner
   * meeting a 403 while it is on has no reason to connect the two.
   */
  it('says the account has less access while it is on', () => {
    render(<PersonaPreviewBanner preview={PREVIEW} onEnded={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(/reduced/i);
  });

  /** Every persona is announced, so none of them renders a blank sentence. */
  it.each(['student', 'organizer', 'admin', 'partner'])('announces the %s persona', (persona) => {
    render(<PersonaPreviewBanner preview={{ ...PREVIEW, persona }} onEnded={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(new RegExp(persona));
  });

  it('ends the preview and asks the session to refresh', async () => {
    const end = vi.spyOn(api, 'endPersonaPreview').mockResolvedValue({ persona: null });
    const onEnded = vi.fn().mockResolvedValue(undefined);

    render(<PersonaPreviewBanner preview={PREVIEW} onEnded={onEnded} />);
    fireEvent.click(screen.getByRole('button', { name: /stop previewing/i }));

    await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    /**
     * The refetch is the assertion that matters. Capabilities changed on the
     * server, so every gated control on the page is stale — a component that
     * patched its own state instead would leave the rest of the shell rendering
     * the previewed role until something unrelated happened to refresh it.
     */
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
  });

  /**
   * A failed exit leaves the banner up and says why.
   *
   * Removing it on failure would be the worst outcome available: the preview is
   * still in force server-side, and the only signpost to that fact just
   * disappeared.
   */
  it('keeps itself on screen when ending fails', async () => {
    vi.spyOn(api, 'endPersonaPreview').mockRejectedValue(
      Object.assign(new Error('nope'), { data: { error: 'Could not reach the server.' } })
    );

    render(<PersonaPreviewBanner preview={PREVIEW} onEnded={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /stop previewing/i }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/could not reach the server/i));
    expect(screen.getByRole('button', { name: /stop previewing/i })).toBeTruthy();
  });

  it('disables the button while the request is in flight', async () => {
    let release;
    vi.spyOn(api, 'endPersonaPreview').mockReturnValue(new Promise(r => { release = r; }));

    render(<PersonaPreviewBanner preview={PREVIEW} onEnded={vi.fn()} />);
    const button = screen.getByRole('button', { name: /stop previewing/i });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: /stopping/i }).disabled).toBe(true));
    release({ persona: null });
  });
});

/**
 * ── The client mirror narrows in step with the server ──
 *
 * Not a security boundary — `src/authz.js` says so in its own header, and the
 * server re-checks every capability. It is the drift that matters: without this,
 * a previewing owner would be shown their full administrative navigation while
 * every one of those pages 403'd, which is the most confusing possible outcome
 * for a feature whose entire purpose is to show somebody an accurate picture.
 */
describe('the client can() follows a preview', () => {
  const OWNER = { id: 'u1', role: 'super_admin', withheld: [], grants: [] };

  it('narrows an owner previewing as a student', () => {
    const previewing = { ...OWNER, preview: { persona: 'student' } };

    expect(can(OWNER, 'audit.read')).toBe(true);
    expect(can(previewing, 'audit.read')).toBe(false);
    expect(can(previewing, 'report.resolve')).toBe(false);
    expect(can(previewing, 'event.apply')).toBe(true);
  });

  /**
   * And it cannot be used the other way around.
   *
   * A `preview` field set by hand in a debugger, or forged into a response, adds
   * nothing — `decide` intersects the persona with the real role, exactly as the
   * server does, because it is the same function.
   */
  it('gives a student nothing when a preview claims the owner persona', () => {
    const student = { id: 'u2', role: 'student', withheld: [], grants: [] };
    const forged = { ...student, preview: { persona: 'super_admin' } };

    for (const cap of ['audit.read', 'admin.create', 'report.resolve', 'error.read',
      'analytics.platform', 'persona.preview']) {
      expect(can(forged, cap), `a forged client-side preview offered ${cap}`).toBe(false);
    }
  });

  /** The exit control is never hidden by the preview that needs it. */
  it.each(['student', 'organizer', 'admin', 'partner'])(
    'keeps persona.preview.exit while previewing as %s', (persona) => {
      expect(can({ ...OWNER, preview: { persona } }, 'persona.preview.exit')).toBe(true);
    });

  it('is unchanged for a payload with no preview field', () => {
    expect(can(OWNER, 'audit.read')).toBe(true);
    expect(can({ ...OWNER, preview: null }, 'audit.read')).toBe(true);
  });
});
