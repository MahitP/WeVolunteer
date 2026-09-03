import { useNavigate } from 'react-router-dom';
import { LogIn, UserPlus } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import { rememberPendingInvite } from '../../utils/pendingInvite';

/**
 * What a visitor with no account is told when they press Join.
 *
 * ── Why a dialog and not a redirect ──
 *
 * Sending them straight to the sign-in screen answers a question they did not
 * ask. They pressed Join on a club; the reason they now need to sign in is not
 * self-evident, and a form appearing in place of the page they were reading
 * reads as having lost their place. One sentence explaining why, and two clearly
 * different doors, keeps them oriented.
 *
 * ── Preserving where they were going ──
 *
 * The club's slug and the invitation token are written to `sessionStorage`
 * before navigating, and picked up after a successful sign-in or signup. That is
 * deliberately NOT a `returnTo` parameter: what is stored is a slug this
 * application's own server produced, and the consumer interpolates it into a
 * fixed `/organizations/…` prefix — so there is no input that can make it
 * navigate anywhere else, and nothing to validate. See
 * `src/utils/pendingInvite.js`.
 *
 * A failed write (a private window, blocked site data) loses the destination and
 * nothing else: the person still signs in, and lands on the dashboard rather
 * than on the club. That is the right way round for a storage failure.
 */
export default function SignInToJoinDialog({ organization, token, onClose }) {
  const navigate = useNavigate();
  const name = organization?.name ?? 'this organization';

  const go = (to) => {
    rememberPendingInvite({ slug: organization?.slug, token, name: organization?.name });
    navigate(to);
  };

  return (
    <Modal onClose={onClose} label={`Sign in to join ${name}`}>
      <ModalHead
        title={`Join ${name}`}
        description="Joining an organization needs a WeVolunteer account. It takes a minute, and it is what lets an organizer credit your hours."
        onClose={onClose}
      />

      <div className="modal-body stack-md">
        <p className="muted">
          We will bring you straight back here once you are signed in.
        </p>

        <div className="stack-sm org-signin-choices">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => go('/signup')}>
            <UserPlus size={17} aria-hidden="true" /> Create an account
          </button>
          <button type="button" className="btn btn-secondary btn-lg" onClick={() => go('/login')}>
            <LogIn size={17} aria-hidden="true" /> Log in
          </button>
        </div>

        {/* Signing up is the primary because the reader is, by construction,
            somebody without an account. Logging in is offered second and just as
            plainly, because a student who has one and simply is not signed in on
            this device is the other half of the audience. */}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Not now
        </button>
      </div>
    </Modal>
  );
}
