import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * What the row under the composer says, and the one thing it must not.
 *
 * ── Why there is a disclaimer at all ──
 *
 * Asked for directly: "a small legal disclaimer would fit its place […] still
 * don't type in sensitive information (because even though we don't see it its
 * still good practice) and also that this AI makes mistakes (a lot actually)
 * its only meant to be for like helping you with the volunteering stuff."
 *
 * ── The claim it deliberately does not make ──
 *
 * The same message asked for "nothing leaves your device (which it does)". It
 * is the natural reading of the mode pill and it is not true of the whole
 * feature. The model runs in the browser, but a lookup about the reader's own
 * hours or events is answered by WeVolunteer's server exactly as the rest of
 * the app is, and a search sends the words searched for, which the server may
 * pass on to Pinecone. Even "what you type stays on your device" is false for
 * that reason. It was ruling 14's first wording, amended on 2026-10-04 once
 * this file was run with Welly AI on and failed on it. The AI policy says every
 * half; a footnote that says only the flattering one would make the assistant's
 * single privacy claim the one place it overstates itself.
 *
 * So the on-device claim stays in the mode panel, which knows whether the model
 * is actually running, and this row links to the policy. That is a deliberate
 * departure from what was asked for, and this test is where it is written down.
 */

/**
 * Whether this build ships Welly AI, switchable per test.
 *
 * The ruling-14 clause renders only when `isLocalAIEnabled()` is true, and
 * vitest leaves `VITE_LOCAL_AI` unset, so with the real flag this file never
 * saw the one sentence it exists to check. It passed from 2026-10-01 to
 * 2026-10-04 while the footer said "what you type stays on your device",
 * and failed on it when run with the flag on. Production builds
 * default the flag to on (`vite.config.js`), so both states are tested.
 */
const flags = vi.hoisted(() => ({ localAI: false }));
vi.mock('../ai', async (importOriginal) => ({
  ...(await importOriginal()),
  isLocalAIEnabled: () => flags.localAI,
}));

vi.mock('../utils/api', () => ({
  api: {
    fetchVolunteerStats: vi.fn().mockResolvedValue(null),
    fetchCertificates: vi.fn().mockResolvedValue([]),
    fetchOrganizations: vi.fn().mockResolvedValue([]),
    fetchApplications: vi.fn().mockResolvedValue([]),
    fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [], pagination: { total: 0 } }),
    verifyCertificate: vi.fn(),
  },
}));

const { default: WellyView } = await import('./WellyView.jsx');

let seq = 0;
const show = () => render(
  <MemoryRouter>
    <WellyView currentUser={{ id: `stu-disc-${++seq}`, name: 'Maya Lin', role: 'student', verified: true, withheld: [] }} />
  </MemoryRouter>,
);

const footer = () => document.querySelector('.welly-composer-footer');
const longForm = () => document.querySelector('.welly-footer-long').textContent;
const shortForm = () => document.querySelector('.welly-footer-short').textContent;

beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); flags.localAI = false; });

describe('the disclaimer under the composer', () => {
  it('says Welly makes mistakes, in those words', () => {
    show();
    /* Not "may occasionally be inaccurate". This is a sub-2B model in a browser
       tab and the reader is a student who might otherwise trust it against
       their own transcript. */
    expect(footer().textContent).toMatch(/makes mistakes/i);
    expect(footer().textContent).toMatch(/check anything that matters/i);
  });

  it('says what it is for', () => {
    show();
    expect(footer().textContent).toMatch(/volunteering/i);
    expect(footer().textContent).toMatch(/prototype/i);
  });

  it('asks the reader not to type personal details', () => {
    show();
    expect(footer().textContent).toMatch(/don’t type personal details|don't type personal details/i);
  });

  it('keeps the promise that nothing changes without confirmation', () => {
    /* This was on the row before the disclaimer replaced it and is a real
       guarantee — every mutation goes through draft-and-confirm. It was not
       dropped in the rewrite. */
    show();
    expect(footer().textContent).toMatch(/without your confirmation/i);
  });

  it('links to the policy rather than summarising it', () => {
    show();
    expect(screen.getByRole('link', { name: /how welly uses your information/i }))
      .toHaveAttribute('href', '/legal/ai-and-on-device-processing');
  });

  it('keeps both safety clauses in the short form too', () => {
    /**
     * The full sentence wraps to three lines on a phone in landscape and pushed
     * the composer off the bottom of the screen. The old answer was to hide the
     * footer entirely below 520px tall, which is not available for a
     * disclaimer — small screens are most screens.
     *
     * So there are two wordings, swapped by a media query, and the short one
     * gives up the reassurance rather than either of the warnings. This is what
     * stops a future trim taking a clause out of one and leaving it in the
     * other, where nobody would notice which.
     */
    show();
    for (const text of [longForm(), shortForm()]) {
      expect(text).toMatch(/makes mistakes/i);
      expect(text).toMatch(/don’t type personal details|don't type personal details/i);
    }
    /* Shorter, or it is not doing its job. */
    expect(shortForm().trim().length).toBeLessThan(longForm().trim().length);
  });

  for (const localAI of [false, true]) {
    it(`never claims that nothing leaves the device (Welly AI ${localAI ? 'on' : 'off'})`, () => {
      /**
       * The assertion this file exists for. A lookup about the reader's own
       * record IS sent to WeVolunteer's server, and a search sends the words
       * searched for, so "nothing leaves your device", or "what you type stays
       * on your device", would be false here. Both are sentences a future edit
       * will reach for.
       */
      flags.localAI = localAI;
      show();
      /* Both wordings, since either could be the one on screen. */
      const text = footer().textContent;
      expect(text).not.toMatch(/nothing leaves|never leaves|stays on your device|no data is sent/i);
      expect(text).not.toMatch(/what you type stays|nothing you type/i);
      expect(text).not.toMatch(/private|encrypted|anonymous/i);
    });
  }

  it('with Welly AI on, says what runs on the device and what a search sends', () => {
    flags.localAI = true;
    show();
    expect(longForm()).toMatch(/the model that writes Welly's replies runs on your device/);
    expect(longForm()).toMatch(/a search sends the words you searched for/);
  });

  it('without Welly AI, does not name the engine at all', () => {
    show();
    expect(footer().textContent).not.toMatch(/Welly AI/);
  });
});
