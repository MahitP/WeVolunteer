import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import NoticeBanner from './NoticeBanner';

/**
 * The question that makes the analytics switch reachable.
 *
 * ── Why this exists ──
 *
 * `users.analytics_consent` starts `null`, meaning "never asked", and analytics
 * only runs on an explicit `true`. That is correct and deliberate. But nothing
 * ever asked: the only place the switch appeared was Settings → Privacy, so
 * somebody would have had to already know the feature existed, go looking for
 * it, and turn it on. Every account in production sat at `null`, so analytics
 * recorded nothing at all — the right outcome arrived at by nobody being
 * offered a choice, which is not the same as somebody declining one.
 *
 * ── What it must not become ──
 *
 * The Privacy Policy says, in these words, "**We do not turn analytics on for
 * you**", and the Cookie Notice says that if you never touch that switch, no
 * analytics company hears about you at all. The Cookie Notice also records why
 * those sentences exist: an Amplitude SDK with Session Replay was once on by
 * default, and a release-candidate audit caught it.
 *
 * So this asks. It does not persuade, nothing is pre-ticked, and a decline is
 * one click and permanent. If it ever acquires a highlighted Yes against a
 * muted No, or a "not now" that quietly re-asks next week, it has become the
 * thing that audit found.
 *
 * ── Why there is no dismiss X ──
 *
 * Every other notice in this slot can be waved away, because ignoring those
 * changes nothing. This one is a question about what gets recorded, and an
 * unanswered question is indistinguishable from a question nobody read — which
 * is exactly the state that produced this component. Both answers are one click
 * and neither comes back, so nobody is trapped.
 *
 * `No thanks` is written first, and in the same weight as the other. Both are
 * `btn-secondary`: the slot's own convention is `btn-primary` for the action it
 * wants you to take, and there is no answer this is supposed to want.
 *
 * ── Why it names the screen recording ──
 *
 * "Usage analytics" sounds like counting page views. What is actually switched
 * on is `initAll` with Session Replay at `sampleRate: 1` — a recording of the
 * screen, with text masked conservatively. The Privacy Policy already describes
 * it that way, and consent to something described more gently than the policy
 * describes it is not consent to that thing.
 */
export default function AnalyticsConsentPrompt({ onAnswer }) {
  const [saving, setSaving] = useState(false);

  /* One in-flight answer. Both buttons disable together, so a double click
     cannot record the opposite of whichever was pressed second. */
  const answer = async (consented) => {
    if (saving) return;
    setSaving(true);
    try {
      await onAnswer(consented);
    } catch {
      /* Swallowed HERE, not left to the caller.
         `AppNotices` already catches, so in the shell this never fires — but a
         component that only behaves when its caller remembers to catch is one
         refactor from an unhandled rejection in a child's browser console.
         Caught by the "stays usable when saving fails" test, which reported the
         rejection before any human saw it.
         Nothing is shown: the question is still on screen and still
         unanswered, which says more than a toast about a feature nobody asked
         for. */
    } finally {
      /* The banner usually unmounts on success — the shell refetches the
         session and the answer is no longer `null`. On failure it stays, and
         has to be usable again. */
      setSaving(false);
    }
  };

  return (
    <NoticeBanner
      label="Usage analytics"
      icon={<BarChart3 size={16} />}
      title="May we record how you use WeVolunteer?"
      action={(
        <>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => answer(false)}
            disabled={saving}
          >
            No thanks
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => answer(true)}
            disabled={saving}
          >
            Yes, that is fine
          </button>
        </>
      )}
    >
      It would help us find what is confusing or broken. It includes a recording of your
      screen with the text hidden, and it goes to Amplitude, a company outside WeVolunteer.
      Nothing is recorded unless you say yes, and you can change your mind any time in
      Settings.{' '}
      {/* Not "learn more": the reader is deciding now, and a link they are asked
          to trust should say what is on the other side of it. */}
      <Link className="auth-link" to="/legal/cookie-and-tracking-notice">
        What this records, in full
      </Link>
    </NoticeBanner>
  );
}
