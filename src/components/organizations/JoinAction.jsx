import { LogIn, Clock, Lock, Check, Scale, UserPlus2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatDay } from '../../utils/helpers';

/**
 * The one primary control on an organization page.
 *
 * ── It renders what the server said, and computes nothing ──
 *
 * `viewer.affordance` is one of seven values decided by `joinAffordance` on the
 * server, against the club's policy, the membership row, an active ban, the
 * organization's status and the caller's capability. This component is a lookup
 * from that value to a control. It deliberately does not know the rule: a client
 * that could work out which button to show would be the second implementation of
 * the membership policy, and the way those two drift is that the UI offers a
 * button the API rejects.
 *
 * It adds nothing at all, and that is deliberate. The one thing the server
 * cannot know — that this tab is holding an invitation token — is resolved by
 * the PAGE before it reaches here, because the sentence under this control has
 * to agree with it. When that was decided inside this component instead, the
 * button said Join while the line beneath it told the reader to go and ask
 * somebody for a link.
 *
 * ── Leaving is not here ──
 *
 * A member's primary control is a state, not an action. Leaving is the rarest and
 * most destructive thing on the page and it belongs in the actions menu beside
 * it — it used to occupy the position a newcomer's Join occupies, which made the
 * loudest control on a member's page the one that ends their membership.
 */
export default function JoinAction({
  affordance,
  organization,
  request,
  ban,
  busy = false,
  onJoin,
  onRequest,
}) {
  const name = organization?.name ?? 'this organization';

  switch (affordance) {
    case 'join':
      return (
        <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={onJoin}>
          <LogIn size={17} aria-hidden="true" /> Join {name}
        </button>
      );

    case 'request':
      return (
        <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={onRequest}>
          <UserPlus2 size={17} aria-hidden="true" /> Request to join
        </button>
      );

    case 'pending':
      /* Disabled rather than hidden: "did my request go through" is exactly what
         somebody comes back to the page to check, and a control that vanishes
         answers nothing. Taking it back lives in the menu, because it is a
         different decision from making it. */
      return (
        <button
          type="button"
          className="btn btn-secondary btn-lg"
          disabled
          title={request?.submittedAt ? `Sent ${formatDay(request.submittedAt)}` : undefined}
        >
          <Clock size={17} aria-hidden="true" /> Request sent
        </button>
      );

    case 'invite_required':
      /**
       * Disabled, and honest about why.
       *
       * The alternative — hiding it — leaves a page with no primary action and
       * no explanation, which reads as the club being broken. A button that
       * says what is missing, beside a sentence saying how to get it, is a
       * closed door with a sign on it rather than a wall.
       */
      return (
        <button type="button" className="btn btn-secondary btn-lg" disabled>
          <Lock size={17} aria-hidden="true" /> Invitation required
        </button>
      );

    case 'member':
      return (
        <p className="org-member-state">
          <Check size={17} aria-hidden="true" />
          <span>You are a member</span>
        </p>
      );

    case 'banned':
      /* The existing appeal flow, unchanged. A student told they are banned and
         given nothing to do about it has nothing to appeal against. */
      if (ban?.appeal?.pending) {
        return (
          <button
            type="button"
            className="btn btn-secondary btn-lg"
            disabled
            title={`Appeal sent ${formatDay(ban.appeal.submittedAt)}`}
          >
            <Clock size={17} aria-hidden="true" /> Appeal sent
          </button>
        );
      }
      return (
        <Link
          className="btn btn-danger btn-lg"
          to={`/appeals/new?subject=organization_ban&organization=${encodeURIComponent(organization?.id ?? '')}`}
        >
          <Scale size={17} aria-hidden="true" /> Appeal
        </Link>
      );

    case 'unavailable':
    default:
      /* Archived, or an account that cannot hold membership at all. Nothing is
         offered, because nothing would work. The sentence beneath carries the
         explanation. */
      return null;
  }
}
