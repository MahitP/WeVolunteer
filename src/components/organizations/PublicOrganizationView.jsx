import { Link } from 'react-router-dom';
import { Building2, CalendarDays } from 'lucide-react';
import OrganizationMasthead from './OrganizationMasthead';
import EmptyState from '../common/EmptyState';
import BrandLockup from '../common/BrandLockup';
import { APP_NAME } from '../../config';
import { formatDay } from '../../utils/helpers';
import './OrganizationExperience.css';

/**
 * The club as a stranger sees it.
 *
 * ── Why the two public pages share this and are not one page ──
 *
 * An invitation link and a public handle open the same PROJECTION and mean
 * completely different things. The link is a credential — it works for a club
 * that is unlisted, and it is what makes a Join press succeed at an
 * invitation-only club. The handle is an address — it works only for a club that
 * chose to be public, and it carries no authority at all.
 *
 * So the two views keep their own routes, their own headers and their own
 * actions, and share the part where they genuinely agree: how a club is
 * presented, and what is deliberately absent from it. Duplicating this was the
 * alternative, and the thing that would have drifted is the absent half — the
 * allowlist is only as good as the least careful of its two renderers.
 *
 * ── What is not here, and why ──
 *
 * No member, no founder, no roster, no hours, no announcement, no id, and no
 * event LOCATION. `publicOrganization` on the server is the allowlist and its
 * header argues field by field; this renders what that sends and asks for
 * nothing else. The location is the one worth restating: an event's location is
 * where named minors will physically be, at a stated time, and no unauthenticated
 * page on this platform publishes that.
 */
export default function PublicOrganizationView({ organization, action, note, headingLevel = 'h1' }) {
  return (
    <>
      <OrganizationMasthead
        organization={organization}
        as={headingLevel}
        action={action}
        note={note}
      />

      {/**
        * What the club has coming up — titles, dates, categories, nothing else.
        *
        * This is the club advertising itself, which is what a title and a date
        * are. A time and a place would be something else.
        */}
      <section className="card" aria-labelledby="public-org-upcoming">
        <div className="card-head">
          <h2 id="public-org-upcoming">Coming up</h2>
        </div>
        <div className="card-body">
          {organization.upcoming?.length ? (
            <ul className="list">
              {organization.upcoming.map((event, i) => (
                <li key={`${event.title}-${i}`} className="list-row invite-upcoming-row">
                  <span className="stack-xs">
                    <span className="invite-upcoming-title">{event.title}</span>
                    <span className="muted small">
                      {event.startsAt ? formatDay(event.startsAt) : 'Date to be confirmed'}
                      {event.category && <> · {event.category}</>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={CalendarDays}
              title="Nothing scheduled yet"
              message={`${organization.name} has not posted an event yet. `
                + 'Join and you will be told when it does.'}
            />
          )}
        </div>
      </section>

      <p className="muted small invite-foot">
        <Building2 size={13} aria-hidden="true" />{' '}
        {APP_NAME} is where schools and community groups organise volunteering and keep a
        record of service hours. <Link to="/about">What is this?</Link>
      </p>
    </>
  );
}

/**
 * The topbar both public pages wear, after the one `CertificateVerification`
 * uses.
 *
 * Somebody arriving here has followed a link from outside and may never have
 * seen this application. The wordmark is how they find out what they are
 * looking at before deciding whether to make an account, and `sub` says which
 * part of the product this is.
 *
 * The wordmark links home rather than being inert: unlike a certificate check,
 * these pages are trying to interest somebody in the product, so the way out
 * should be the front door.
 */
export function PublicOrganizationTopbar({ sub }) {
  return (
    <header className="topbar invite-topbar">
      <Link className="brand" to="/welcome">
        {/* The same lockup as the app shell (N10). */}
        <BrandLockup sub={sub} />
      </Link>
    </header>
  );
}
