import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsConsentPrompt from './AnalyticsConsentPrompt';

/**
 * Consent, asked of children, for a screen recording.
 *
 * ── What this file is protecting ──
 *
 * The Privacy Policy says in these words "We do not turn analytics on for you",
 * and the Cookie Notice says that if you never touch the switch, no analytics
 * company hears about you at all. The Cookie Notice also records why those
 * sentences exist: an Amplitude SDK with Session Replay was once on by default
 * and a release-candidate audit caught it.
 *
 * A prompt is the natural place for that to come back. Not by being reverted —
 * by drifting. A highlighted Yes against a muted No, a "maybe later" that
 * re-asks, copy that says "usage analytics" and omits the screen recording:
 * each is a small edit that looks like polish and moves consent toward the
 * default the audit rejected. These tests are what makes those edits fail.
 */

const draw = (onAnswer = vi.fn().mockResolvedValue(undefined)) => {
  const utils = render(
    <MemoryRouter><AnalyticsConsentPrompt onAnswer={onAnswer} /></MemoryRouter>
  );
  return { ...utils, onAnswer };
};

beforeEach(() => vi.clearAllMocks());

describe('the question is asked honestly', () => {
  it('names the screen recording, not just "analytics"', () => {
    /* `initAll` starts Session Replay at sampleRate 1. Consent to something
       described more gently than the Privacy Policy describes it is not
       consent to that thing. */
    draw();
    expect(screen.getByText(/recording of your screen/i)).toBeInTheDocument();
  });

  it('names the third party the recording goes to', () => {
    draw();
    expect(screen.getByText(/Amplitude/)).toBeInTheDocument();
  });

  it('says nothing is recorded without a yes', () => {
    draw();
    expect(screen.getByText(/nothing is recorded unless you say yes/i)).toBeInTheDocument();
  });

  it('links to the notice that describes it in full', () => {
    draw();
    const link = screen.getByRole('link', { name: /what this records/i });
    expect(link).toHaveAttribute('href', '/legal/cookie-and-tracking-notice');
  });
});

describe('neither answer is nudged', () => {
  it('gives both answers the same visual weight', () => {
    /* The slot's convention is btn-primary for the action it wants taken.
       There is no answer this is supposed to want, so neither gets it. A
       highlighted Yes against a plain No is the dark pattern this forbids. */
    draw();
    const no = screen.getByRole('button', { name: /no thanks/i });
    const yes = screen.getByRole('button', { name: /yes/i });
    expect(no.className).toBe(yes.className);
    expect(yes.className).not.toMatch(/btn-primary/);
  });

  it('puts the declining answer first', () => {
    /* The answer that collects nothing should not be the one that takes more
       looking for. */
    draw();
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveAccessibleName(/no thanks/i);
  });

  it('offers no way to leave the question unanswered', () => {
    /* Deliberately unlike every other notice in this slot. An unanswered
       question is indistinguishable from one nobody read, which is the state
       that produced this component — every account sitting at null. A
       "not now" would recreate it. */
    draw();
    expect(screen.queryByRole('button', { name: /dismiss|not now|later|close/i }))
      .not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('pre-selects nothing', () => {
    draw();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('the answer that is recorded is the answer that was pressed', () => {
  it('sends false for "No thanks"', async () => {
    const { onAnswer } = draw();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /no thanks/i })); });
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it('sends true for "Yes"', async () => {
    const { onAnswer } = draw();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /yes/i })); });
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it('cannot record the opposite of a double click', async () => {
    /* Both buttons disable together while an answer is in flight. Without
       that, clicking No then Yes quickly sends two writes whose order at the
       server is not the order they were pressed — and the one that loses is
       the one the reader saw themselves click. */
    let release;
    const onAnswer = vi.fn(() => new Promise((r) => { release = r; }));
    draw(onAnswer);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /no thanks/i })); });
    expect(screen.getByRole('button', { name: /yes/i })).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /yes/i })); });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(false);

    release();
  });

  it('stays usable when saving fails', async () => {
    /* The banner is left on screen rather than replaced by an error toast:
       the question is still unanswered, and saying so where it was asked is
       more use than an alert about a feature nobody requested. */
    const onAnswer = vi.fn().mockRejectedValue(new Error('offline'));
    draw(onAnswer);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /no thanks/i })); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /no thanks/i })).not.toBeDisabled();
    });
  });
});
