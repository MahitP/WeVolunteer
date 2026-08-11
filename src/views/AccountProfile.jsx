/**
 * The profile page for an account that is not a volunteer or an organizer.
 *
 * ── Who lands here ──
 *
 * The platform owner, an administrator, and a community partner. Two of those
 * used to get a 403 from their own profile URL and the third got a page listing
 * four facts; none of them had anywhere to say what the account is.
 *
 * ── Why it renders from `currentUser` and fetches nothing ──
 *
 * `/api/auth/me` already carries everything below — name, username, avatar,
 * bio, location, skills, hobbies, credited hours, and the two distinguished
 * fields — and the shell has it in hand before this mounts. That is not merely
 * an optimisation:
 *
 *   - A partner does not hold `directory.read`, deliberately (see the note in
 *     server/authz.js: the directory is a searchable list of schoolchildren and
 *     an external organization has no business in it). Every profile endpoint is
 *     behind that capability, so a partner cannot fetch a profile payload —
 *     including their own. A page built on a request they are not allowed to
 *     make would be a page that answers 403 to its own owner.
 *   - There is no loading state and no failure state to design, which is the
 *     right shape for a page whose entire content is already known.
 *
 * ── The distinguished treatment, and why it is additive ──
 *
 * `distinction` arrives from the server as a pure function of `users.role`
 * (`distinctionFor`, server/profileSerializer.js). Nothing here compares a
 * username: the account that prompted this work belongs to a real person, and a
 * rule naming them would be invisible to `authz.js`, uninheritable by the next
 * partner, and wrong the day the account changes hands.
 *
 * Because it is additive, the volunteering and interests sections below render
 * from the same data any member's would. The owner of this platform is a
 * high-school student who volunteers; their hours are real service and belong on
 * their profile. The sections appear when there is something in them and are
 * absent when there is not — the condition is the DATA, never the role.
 */
import { Link } from 'react-router-dom';
import {
  AtSign, Clock, MapPin, Pencil, Settings as SettingsIcon, ShieldCheck, Sparkles, Check,
} from 'lucide-react';
import { can } from '../authz';
import { formatHours } from '../utils/helpers';
import { DistinctionBanner, DistinctionTag } from '../components/profile/Distinction';

/**
 * A labelled row of chips.
 *
 * Deliberately the same markup and the same classes as PublicProfile's — not
 * imported from it, because that file does not export it and lifting a
 * nine-line helper into a shared component is a refactor with its own tests to
 * move rather than something to do in passing. What must not drift is the
 * classes, and those are the stylesheet's, not this file's.
 */
function ChipRow({ title, items, icon: Icon }) {
  return (
    <div className="stack-xs">
      <h3 className="stack-heading">
        <Icon size={14} aria-hidden="true" /> {title}
      </h3>
      <ul className="chips">
        {items.map(item => <li key={item} className="chip">{item}</li>)}
      </ul>
    </div>
  );
}

export default function AccountProfile({ currentUser, onEditProfile }) {
  const {
    name, username, avatar, profile_picture_url: picture, bio, location,
    skills = [], hobbies = [], volunteeredHours = 0, distinction, headline, highlights = [],
  } = currentUser;

  /* Whether this account has actually volunteered. A partner has not, and
     "0.0 hours" on their page would not be an achievement missing — it would be
     a category error. An owner who is also a student HAS, so the block appears
     for them, with no rule anywhere naming either. */
  const hasService = Number(volunteeredHours) > 0;

  return (
    <div className="page stack-lg">
      <section className="card card-pad profile-header">
        <div className="row-between profile-header-top">
          <div className="row profile-identity">
            <span className="avatar avatar-lg" aria-hidden="true">
              {picture
                ? <img src={picture} alt="" className="avatar-img" />
                : (avatar || '🙂')}
            </span>
            <div className="stack-xs">
              <h1 className="profile-name">{name}</h1>
              <DistinctionTag distinction={distinction} />
              {username && <p className="muted profile-handle">@{username}</p>}
              {location && (
                <p className="muted profile-meta">
                  <MapPin size={13} aria-hidden="true" /> {location}
                </p>
              )}
            </div>
          </div>

          {/* Editing is a button on the profile, not an entry in the account
              menu — see the note in components/account/ProfileMenu.jsx. */}
          <div className="row profile-actions">
            <button type="button" className="btn btn-secondary" onClick={onEditProfile}>
              <Pencil size={15} aria-hidden="true" /> Edit profile
            </button>
          </div>
        </div>

        {/* On an institutional account the bio moves into the distinction card,
            where it reads as the account's description of itself rather than as
            an aside under a handle. Same field, drawn once — see the matching
            note in PublicProfile.jsx. */}
        {bio && !distinction && <p className="profile-bio">{bio}</p>}
      </section>

      <DistinctionBanner
        distinction={distinction}
        headline={headline}
        highlights={highlights}
        about={bio}
      />

      {hasService && (
        <section className="card">
          <div className="card-head row-between row-wrap">
            <h2>{distinction?.contributionLabel ?? 'Volunteering'}</h2>
            <span className="tag tag-ok">Confirmed by an organizer</span>
          </div>
          <div className="card-body stack-md">
            <p className="lead row">
              <Clock size={16} aria-hidden="true" /> {formatHours(volunteeredHours)} credited
            </p>
            <p className="small muted">
              Service done on WeVolunteer and confirmed by the organizer who ran it.{' '}
              <Link to="/hours">See your logged hours</Link>.
            </p>
          </div>
        </section>
      )}

      {(hobbies.length > 0 || skills.length > 0) && (
        <section className="card">
          {/* "Interests" is a student word. An organization does not have
              hobbies, so the heading comes from the distinction table — one
              edit adds a third kind of account without a branch here. */}
          <div className="card-head"><h2>{distinction?.interestsLabel ?? 'Interests'}</h2></div>
          <div className="card-body stack-md">
            {hobbies.length > 0 && <ChipRow title="Hobbies" items={hobbies} icon={Sparkles} />}
            {skills.length > 0 && <ChipRow title="Skills" items={skills} icon={Check} />}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2>Your account</h2></div>
        <div className="card-body stack-md">
          <dl className="profile-facts">
            {username && (
              <div>
                <dt><AtSign size={13} aria-hidden="true" /> Username</dt>
                <dd>@{username}</dd>
              </div>
            )}
            <div>
              {/* Stated rather than assumed. A second factor is mandatory for the
                  administrative roles and the account cannot reach an
                  administrative route without one, so its status is a fact about
                  whether the account WORKS — not a preference somebody set. */}
              <dt><ShieldCheck size={13} aria-hidden="true" /> Second factor</dt>
              <dd>
                {currentUser.tfaEnabled || currentUser.tfaEmailEnabled
                  ? 'Enrolled'
                  : 'Not enrolled'}
              </dd>
            </div>
          </dl>
          <div className="row row-wrap">
            {/* Everything administrative is behind the Admin hub, and everything
                about this account is in Settings. Repeating the hub's own list
                here would be a second index to keep in step with the first. */}
            {can(currentUser, 'report.resolve') && (
              <Link className="btn btn-secondary" to="/admin/moderation">
                <ShieldCheck size={15} aria-hidden="true" /> Admin
              </Link>
            )}
            <Link className="btn btn-secondary" to="/settings">
              <SettingsIcon size={15} aria-hidden="true" /> Account settings
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
