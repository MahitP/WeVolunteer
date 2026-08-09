import { Link } from 'react-router-dom';
import { ShieldCheck, AtSign, Mail, KeyRound, Settings as SettingsIcon } from 'lucide-react';

/**
 * The platform owner's own profile page.
 *
 * ── What was here before ──
 *
 * "No service record for this account." That was accurate and it was a dead end.
 * Both profile endpoints filter by role in SQL — the volunteer view requires
 * `role = 'student'` and the organizer view `role IN ('organizer','admin')` — so
 * the owner matched neither, and rather than render a 404 dressed as a profile
 * the route rendered an honest empty state instead. Honest, but it meant the one
 * account that cannot be deleted, cannot be demoted and holds every capability
 * had the emptiest page in the application.
 *
 * ── Why this needs no endpoint ──
 *
 * Everything below is already in `/api/auth/me`, which the shell has in hand
 * before this renders. A profile for a single account is not worth a query that
 * would have to be authorised, scoped and tested — and widening either existing
 * endpoint to admit the owner would change what those return for everybody in
 * order to serve one row.
 *
 * ── What it deliberately does not show ──
 *
 * Service hours. The owner has none, and a "0.0 hours" tile would not be an
 * achievement missing, it would be a category error: this account administers the
 * programme rather than participating in it. The page says what the account IS
 * instead of scoring it against a record it was never going to have.
 *
 * ── A note on the persona preview ──
 *
 * Which profile `/profile` renders is chosen by capability, and `admin.create` is
 * the one that identifies the owner. A preview narrows capabilities, so an owner
 * previewing as a student sees the VOLUNTEER profile — which reports that the
 * record could not be loaded, because there genuinely is no student record for
 * this account. That is the preview being faithful rather than a defect: it is
 * exactly what a student with no service record would meet.
 */
export default function OwnerProfile({ currentUser }) {
  const { name, username, email, role } = currentUser;

  return (
    <div className="page">
      <header className="page-head">
        <h1>{name}</h1>
        <p className="lead">
          This account administers WeVolunteer. It holds every capability on the
          platform, cannot be demoted from inside the product, and is the account
          the audit trail answers to.
        </p>
      </header>

      <div className="card owner-card">
        {/* The same two-case avatar the profile menu uses — an uploaded picture
            if there is one, the chosen emoji otherwise. Not imported from there:
            it is a nested helper in that file, and lifting it into a shared
            component is a refactor with its own tests to move, not a thing to do
            in passing. `alt=""` and `aria-hidden` because the heading beside it
            already carries the name. */}
        {currentUser.profile_picture_url
          ? <img src={currentUser.profile_picture_url} alt="" className="owner-avatar" />
          : <span className="owner-avatar" aria-hidden="true">{currentUser.avatar || '👤'}</span>}
        <dl className="owner-facts">
          <div>
            <dt><ShieldCheck size={14} aria-hidden="true" /> Role</dt>
            <dd>Platform owner</dd>
          </div>
          {username && (
            <div>
              <dt><AtSign size={14} aria-hidden="true" /> Username</dt>
              <dd>@{username}</dd>
            </div>
          )}
          <div>
            <dt><Mail size={14} aria-hidden="true" /> Sign-in address</dt>
            <dd>{email}</dd>
          </div>
          <div>
            {/* Stated rather than assumed. The second factor is mandatory for
                this role and the account cannot reach an administrative route
                without one, so its status is a fact about whether the account
                works — not a setting somebody might have turned off. */}
            <dt><KeyRound size={14} aria-hidden="true" /> Second factor</dt>
            <dd>{currentUser.tfaEnabled || currentUser.tfaEmailEnabled
              ? 'Enrolled — required for this role'
              : 'Not enrolled — administrative pages will refuse this account'}</dd>
          </div>
        </dl>
      </div>

      <div className="owner-links">
        {/* Two destinations, because there are two: everything administrative is
            reached through the Moderation Center, and everything about this
            account is in Settings. Repeating the hub's own list here would be a
            second index to keep in step with the first. */}
        <Link className="btn btn-secondary" to="/admin/moderation">
          <ShieldCheck size={16} aria-hidden="true" /> Moderation Center
        </Link>
        <Link className="btn btn-secondary" to="/settings">
          <SettingsIcon size={16} aria-hidden="true" /> Account settings
        </Link>
      </div>

      {/* `role` is rendered nowhere above as a raw string — this is the one place
          it appears, as a diagnostic, because a page asserting "platform owner"
          should be checkable against what the server actually said. */}
      <p className="owner-note">Signed in as <code>{role}</code>.</p>
    </div>
  );
}
