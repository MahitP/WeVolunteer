import React from 'react';
import { Link } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import NoticeBanner from '../notifications/NoticeBanner';
import { formatLegalDate } from '../../views/legal/legalDates';

/**
 * "We have updated the Privacy Policy."
 *
 * ── Why this is a banner and not the modal it used to be ──
 *
 * Every legal change, however small, used to open a modal over whatever
 * somebody was doing. That is the right weight for a change they have to act
 * on and much too much for a clarification: it interrupts, it dims the page,
 * and the only thing to do about it is dismiss it. Do that twice for a
 * reworded sentence and the reader has learned that legal notices are
 * something to click past, which is the exact habit that makes the notice for
 * the change that DOES matter worthless.
 *
 * So the weights are separated. A clarification is a banner in the shell's
 * notice slot, alongside the location opt-in and styled identically. A
 * material change that has taken effect is a mandatory dialog. The server
 * decides which — see `server/legalConsentGate.js` — and this component never
 * renders for the second kind.
 *
 * ── One banner, however many documents changed ──
 *
 * Five stacked notices is a wall, and a wall gets dismissed unread. The
 * aggregate is a single banner that names one document and counts the rest,
 * because the alternative — a list inside a two-line strip — is a list nobody
 * can read at 375px.
 *
 * Which document gets named is decided by the SERVER's ordering, not by
 * anything here: `pendingNoticesFor` returns them in registry order with the
 * material ones lifted to the front by `sortForDisplay` below, so the same set
 * of pending changes always produces the same banner. A banner whose headline
 * depended on which fetch resolved first would be a different notice on every
 * reload.
 *
 * ── What the copy is careful not to claim ──
 *
 * A MINOR version means, in the Terms' own words, "a clarification… and notice
 * only". Saying so is honest and it is the single most useful thing a reader
 * wants to know: whether they have to do something. What it must NOT say is
 * that nothing changed — something did, the version moved — so the copy says
 * there is nothing to DO and points at the document rather than summarising it.
 *
 * There is deliberately no excerpt here. `buildExcerpt` produces a genuinely
 * new sentence and the mandatory dialog quotes it, because there the reader has
 * stopped anyway. In a two-line banner a quotation is the third and fourth
 * lines of a strip that is supposed to be glanceable, and it competes with the
 * link that actually discharges the obligation.
 */

/**
 * Material changes first, then the server's own order.
 *
 * A stable sort over the array the server sent, so ties keep registry order —
 * which is the order the Legal Center lists them in, so the banner names the
 * document a reader would find first.
 *
 * The reason material ones lead: an advance notice of a change that will
 * require acceptance is the only item in this list with a deadline attached. If
 * a clarification to the Accessibility Statement happened to sort ahead of a
 * major Terms revision taking effect in three weeks, the banner would headline
 * the one nobody needs to act on.
 */
export function sortForDisplay(notices) {
  return [...notices].sort((a, b) => {
    const rank = n => (n.severity === 'material' ? 0 : 1);
    return rank(a) - rank(b);
  });
}

/**
 * The banner's headline and its supporting line, for one set of pending notices.
 *
 * Split out and exported because it is the part with all the branches in it —
 * one document or several, a clarification or advance notice of something
 * material — and asserting on the strings directly is a great deal clearer than
 * asserting on rendered DOM for each of six combinations.
 */
export function noticeCopy(notices) {
  const [primary, ...rest] = sortForDisplay(notices);
  const others = rest.length;

  /**
   * "We have updated the Privacy Policy", never "The Privacy Policy has been
   * updated".
   *
   * Verb agreement. Four of the thirteen registered titles are plural —
   * Community Guidelines, Youth Safety Guidelines — and any template that puts
   * the title in front of the verb has to choose between "has" and "have" from
   * a string. Putting the subject first makes the sentence work for every title
   * in the registry and for every one anybody adds later, and it is the more
   * honest voice besides: somebody changed this document on purpose.
   */
  if (primary.severity === 'material') {
    const when = formatLegalDate(primary.effectiveAt);
    return {
      title: when
        ? `We are updating the ${primary.title} on ${when}`
        : `We are making an important update to the ${primary.title}`,
      body: 'This is a significant change, so we will ask you to accept the new version '
        + 'when it takes effect. You can read it now.'
        + (others > 0 ? ` ${otherDocumentsSentence(others)}` : ''),
    };
  }

  if (others === 0) {
    return {
      title: `We have updated the ${primary.title}`,
      body: `Version ${primary.version} clarifies the existing wording, so there is `
        + 'nothing you need to do. Worth a read when you have a moment.',
    };
  }

  return {
    title: `We have updated ${others + 1} of our documents`,
    /* Deliberately shorter than the single-document line. Measured in a
       browser: the longer version wrapped to two lines at 962px, which made
       the aggregate banner taller than the location one sitting in the same
       slot — the exact "two different apps" impression the shared primitive
       exists to prevent. The button already says where it goes. */
    body: `Including the ${primary.title}. These are clarifications — `
      + 'nothing you need to do.',
  };
}

/** "Two other documents were updated as well." */
function otherDocumentsSentence(others) {
  return others === 1
    ? 'One other document was updated as well.'
    : `${others} other documents were updated as well.`;
}

export default function LegalUpdateNotice({ notices, onDismiss }) {
  if (!notices?.length) return null;

  const [primary, ...rest] = sortForDisplay(notices);
  const { title, body } = noticeCopy(notices);

  /**
   * One document: straight to its own page. Several: the Legal Center.
   *
   * The single case is the one the brief cares about and it uses the canonical
   * route — `/legal/:slug`, the same path the Legal Center links to and the same
   * slug the acceptance record is keyed on. There is no second copy of a
   * document page anywhere and this does not introduce one.
   *
   * The aggregate case cannot honestly send somebody to one document when the
   * banner just told them several changed, and `/legal` is the page that lists
   * every document with its version and effective date. It is the existing hub;
   * nothing new was built for this.
   */
  const target = rest.length === 0 ? `/legal/${primary.slug}` : '/legal';
  const actionLabel = rest.length === 0 ? 'View document' : 'Review updates';

  return (
    <NoticeBanner
      label="Legal document update"
      icon={<ScrollText size={16} />}
      title={title}
      action={(
        /**
         * Following the link dismisses the notice, and that is not a shortcut.
         *
         * Acknowledgement means "this person was shown that the document
         * changed" and is stored in `legal_change_notices`, which is
         * deliberately not the consent table — migration 039 exists to keep
         * those two facts apart. Somebody who has clicked through to the
         * document has unambiguously been shown it, so leaving the banner up
         * afterwards would be nagging them about something they just did.
         *
         * It records nothing about agreement. Nothing on this path can: the
         * endpoint it calls only writes `acknowledged_at`, and the mandatory
         * changes never reach this component at all.
         */
        <Link className="btn btn-primary btn-sm" to={target} onClick={onDismiss}>
          {actionLabel}
        </Link>
      )}
      onDismiss={onDismiss}
      dismissLabel={
        rest.length === 0
          ? `Dismiss — I have seen that the ${primary.title} changed`
          : 'Dismiss — I have seen that these documents changed'
      }
    >
      {body}
    </NoticeBanner>
  );
}
