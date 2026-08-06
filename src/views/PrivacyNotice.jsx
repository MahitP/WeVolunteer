import React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  APP_NAME, SCHOOL_NAME,
  PRIVACY_CONTACT, PRIVACY_RETENTION, PRIVACY_UNDER13, PRIVACY_OWNER,
  privacyNoticeComplete,
} from '../config';

/**
 * The privacy notice, reachable signed in or signed out.
 *
 * ── What this page is, and the line it will not cross ──
 *
 * Until now the application collected minors' names, email addresses, grades and
 * schools and told nobody what it did with them. `VITE_PRIVACY_URL` existed to
 * point at a district's own published notice, and while it was unset the signup
 * acknowledgement did not render at all — so the honest default was silence.
 *
 * This page closes the part of that gap software can honestly close. Everything
 * in the two factual sections below is read off the schema and the route
 * handlers and is true of this software wherever it runs: what is stored, and
 * who can see it. Writing that down is strictly better than saying nothing.
 *
 * What it deliberately does NOT do is invent the district's policy. Retention
 * period, correction-and-deletion contact, and under-13 consent are decisions a
 * district makes and answers for; there is no defensible default. They arrive as
 * build-time configuration, and until every one of them is supplied this page
 * says — at the top, in a warning, before any reassuring content — that it is
 * incomplete and must not be relied on.
 *
 * That ordering is the whole design. `src/config.js` warns that placeholder
 * legal text is worse than none because it manufactures the appearance of a
 * reviewed policy. A page that admits it is unfinished cannot do that. A page
 * that looks finished because a plausible default was filled in silently would.
 *
 * ── Reachable without a session, on purpose ──
 *
 * Someone deciding whether to sign up has to be able to read it first, which is
 * exactly when they have no account. It is in `PUBLIC_ROUTES` for the same
 * reason certificate verification is.
 */

/** A district value, or a visible admission that it is missing. */
function DistrictFact({ label, value, missingHint }) {
  if (value) {
    return (
      <div className="stack-xs">
        <h3>{label}</h3>
        <p>{value}</p>
      </div>
    );
  }
  return (
    <div className="stack-xs">
      <h3>{label}</h3>
      {/* Named as missing rather than omitted. A section quietly absent reads
          as "does not apply"; this has to read as "nobody has answered this". */}
      <p className="alert alert-warn">
        <strong>Not yet provided.</strong> {missingHint}
      </p>
    </div>
  );
}

export default function PrivacyNotice() {
  const complete = privacyNoticeComplete();
  const owner = PRIVACY_OWNER || SCHOOL_NAME;

  return (
    <main className="content legal-page stack-lg" aria-labelledby="privacy-title">
      <div className="stack-sm">
        <h1 id="privacy-title" className="legal-title">Privacy notice</h1>
        <p className="legal-meta">
          How {APP_NAME} handles information about the people who use it.
        </p>
      </div>

      {!complete && (
        /* First thing on the page, before anything reassuring. A reader who
           stops here must still come away knowing this is not a finished
           policy — which is the one outcome that matters if it is not. */
        <div className="alert alert-warn stack-sm" role="status">
          <div className="alert-title">
            <AlertTriangle size={16} aria-hidden="true" /> This notice is not finished
          </div>
          <p>
            The sections below describing <em>what is collected</em> and{' '}
            <em>who can see it</em> are accurate and describe the software as it
            actually behaves. But {owner} has not yet supplied how long records
            are kept, who to contact to correct or delete them, or what applies
            to users under 13.
          </p>
          <p>
            Until those are filled in, <strong>this page is not a reviewed
            privacy policy</strong> and should not be relied on as one.
          </p>
        </div>
      )}

      <section className="stack-sm">
        <div className="section-head"><h2>What is collected</h2></div>
        <p>When an account is created, {APP_NAME} stores:</p>
        <ul>
          <li>Name, email address, and grade level</li>
          <li>Username, and school if one is entered</li>
          <li>Optional profile details: a short bio, an avatar, and listed skills</li>
          <li>A one-way hash of the password — never the password itself</li>
        </ul>
        <p>As the account is used, it also stores:</p>
        <ul>
          <li>Events applied to, and whether each application was accepted, waitlisted, declined, or withdrawn</li>
          <li>Attendance, and the service hours credited for it</li>
          <li>Certificates issued for completed events</li>
          <li>Messages sent through the app, and comments posted on events</li>
          <li>Notification and email preferences</li>
        </ul>
      </section>

      <section className="stack-sm">
        <div className="section-head"><h2>Who can see it</h2></div>
        <ul>
          <li>
            <strong>The account holder</strong> sees everything on their own account,
            and can download a complete copy of it from Settings.
          </li>
          <li>
            <strong>Organizers</strong> of an event see the name and contact details of
            students who apply to <em>that</em> event, so they can select volunteers and
            record attendance. They do not see applications to other people&rsquo;s events.
          </li>
          <li>
            <strong>Administrators</strong> at {owner} can see accounts, events, and
            applications across the platform in order to run it.
          </li>
          <li>
            <strong>Other signed-in users</strong> see only what a profile&rsquo;s visibility
            setting allows. Profiles are <strong>private by default</strong>.
          </li>
          <li>
            <strong>Anyone with a certificate code</strong> can check that certificate,
            which shows the volunteer&rsquo;s name, the event, and the hours. Codes are
            random and are printed on the certificate itself.
          </li>
        </ul>
        <p>
          The community leaderboard shows a student&rsquo;s name and total hours to other
          signed-in users. It is <strong>off unless a student turns it on</strong>, and can
          be turned off again at any time in Settings.
        </p>
      </section>

      <section className="stack-sm">
        <div className="section-head"><h2>What {APP_NAME} does not do</h2></div>
        <ul>
          <li>It does not sell or share this information with advertisers.</li>
          <li>It does not use third-party analytics or advertising trackers.</li>
          <li>
            It does not record the contents of a page in its error logs. When something
            breaks, the diagnostic record is stripped of email addresses, tokens and
            similar identifiers before it is stored, the user is recorded as a one-way
            hash rather than a name or an id, and the address is stored as a route
            pattern rather than the actual URL.
          </li>
        </ul>
      </section>

      <section className="stack-sm">
        <div className="section-head"><h2>{owner}&rsquo;s policy</h2></div>
        <DistrictFact
          label="How long records are kept"
          value={PRIVACY_RETENTION}
          missingHint={`${owner} has not yet stated a retention period.`}
        />
        <DistrictFact
          label="Correcting or deleting your information"
          value={PRIVACY_CONTACT}
          missingHint={`${owner} has not yet named a contact for correction and deletion requests. An account holder can still delete their own account from Settings.`}
        />
        <DistrictFact
          label="Users under 13"
          value={PRIVACY_UNDER13}
          missingHint={`${owner} has not yet stated whether accounts under 13 are in scope, or what consent applies to them.`}
        />
      </section>
    </main>
  );
}
