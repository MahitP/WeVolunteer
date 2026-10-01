import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Compass, ClipboardList, Users, HeartHandshake, Crown } from 'lucide-react';
import { APP_NAME, SUPPORT_EMAIL, DOCUMENT_SIGNATORY_TITLE } from '../config';
import { api } from '../utils/api';
import { avatarColorValue } from '../utils/avatarColors';
import useDocumentTitle from '../hooks/useDocumentTitle';
import CopyableEmail from '../components/common/CopyableEmail';
import { usePageMeta } from '../hooks/usePageMeta';

/**
 * About Us — what WeVolunteer is for.
 *
 * ── Why this is a written page and not an editable one ──
 *
 * It sits beside the Legal Center in Settings and is reached the same way, so the
 * obvious question is why the owner editor does not manage this too. The answer
 * is that the editor exists for documents that change under pressure — a
 * regulator, a lawyer, a school district — where waiting for a deploy is the
 * problem. Nothing here is like that. This is prose about intent, and the intent
 * changing is exactly the occasion when a considered edit in a pull request is
 * better than a text box.
 *
 * ── Why it renders on the legal surface's reading scale ──
 *
 * `.legal-page` and the type below come from the reading scale documented in
 * `docs/legal/02-DESIGN-SYSTEM.md`, which exists because the product's type is
 * tuned for scanning dense dashboards and this is prose meant to be read.
 *
 * ── Rules this page is held to ──
 *
 * 1. No claim that cannot be checked against this repository. No nonprofit
 *    status, no partnerships, no certifications, no awards, no endorsements, no
 *    user numbers, no impact figures. A page whose whole job is to earn trust is
 *    the worst possible place to say something untrue.
 * 2. Every substantive claim about behaviour names behaviour the software
 *    actually has. The two load-bearing ones are the hours record (derived on
 *    every read from `attendance`, never stored as an editable total — see
 *    `hoursLedger.js`) and the Auto Select draw (which favours volunteers with
 *    FEWER credited hours — see the header of `weighting.js`). If either of those
 *    changes, this page is wrong and has to change with it.
 * 3. No "not X, but Y". An earlier draft leaned on that construction about twenty
 *    times in nineteen hundred words, which stops reading as emphasis and starts
 *    reading as a tic — and once a reader notices the cadence they stop believing
 *    any individual sentence in it.
 * 4. Concrete nouns. The passages here that work are the ones made of flyers,
 *    group chats and Saturday mornings; the ones that failed were made of
 *    "meaningful engagement".
 */

/**
 * What we believe.
 *
 * Five, not seven. The earlier seven included "Technology should serve people,
 * not get in their way" and "Organizers deserve tools that make their work
 * easier" — sentences that have been on product pages since 1998 and are true of
 * dishwashers. Lengths vary on purpose: a list where every item is the same size
 * is a list somebody filled in rather than wrote.
 */
const BELIEFS = [
  {
    name: 'Showing up once still counts.',
    body: 'Three hours at one event is a real contribution. When more people want a '
      + 'place than there are places, the draw that picks them actually favours the '
      + 'volunteers with fewer recorded hours, so turning up for the first time does '
      + 'not put you at the back of the queue behind somebody with two hundred.',
  },
  {
    name: 'Finding the opportunity is the hard part.',
    body: 'Most volunteer coordination happens in places you have to already know '
      + 'about. If someone cannot find something that fits the Saturday they actually '
      + 'have free, nothing else here matters.',
  },
  {
    name: 'Hours are a record, not a score.',
    body: 'We track them because schools and programs require them tracked. We try '
      + 'not to let the number become the reason anybody came.',
  },
  {
    name: 'Somebody stays up the night before making the sign-up sheet.',
    body: 'That person is usually a volunteer themselves, and the work is invisible '
      + 'until it does not get done. Taking it off their plate is one of the more '
      + 'useful things software like this can do.',
  },
  {
    name: 'These records affect real decisions.',
    body: 'Service hours go into graduation requirements, scholarships and '
      + 'applications. People rely on them being right, which makes accuracy an '
      + 'obligation rather than a feature we could trade away for convenience.',
  },
];

/** The two sides of the same problem. */
const AUDIENCES = [
  {
    key: 'volunteers',
    Icon: Compass,
    title: 'For volunteers',
    lead: 'If you are here to volunteer, this should do a few specific things for you.',
    points: [
      ['See what is actually available', 'Real events with real dates and a spot count you can trust, without emailing somebody to ask.'],
      ['Know what you are signing up for', 'What the work involves, how long it runs, where it is, and what to bring. Nobody should show up to a surprise.'],
      ['Find things that fit', 'Your schedule, your area, and the kind of work you want to do.'],
      ['Keep a record you can hand over', 'Every hour you are credited stays attached to the event and the date it came from. If a school or a program asks, you can show the work rather than just the number.'],
    ],
  },
  {
    key: 'organizers',
    Icon: ClipboardList,
    title: 'For organizers',
    lead: 'If you run events, this is meant to take work off your plate, not add a system to learn.',
    points: [
      ['One place your events live', 'People find them and sign up without going through you first.'],
      ['A roster that stays current', 'Who signed up, how many places are left, who confirmed, and who actually arrived.'],
      ['Less to send by hand', 'Reminders go out on their own, and the attendance record is finished when the event is.'],
      ['A record you do not have to reconstruct', 'What happened on the day, written down while it was happening.'],
    ],
  },
];

/** What actually changes, none of which happens on this website. */
const OUTCOMES = [
  'A student shows up on a Saturday morning who otherwise would not have known to.',
  'An organizer runs an event that works, because the people who said they were coming came.',
  'A community project gets the number of volunteers it actually needed.',
  'Someone finds out they like this, and comes back without being asked.',
];

/**
 * What we intend to hold to.
 *
 * Five, not seven. "Continuous improvement" and "People before the platform" are
 * gone — the first is a values poster, and the second implied growth metrics this
 * product does not have and a business model it is not. Each of these makes a
 * claim a reader could hold us to.
 */
const COMMITMENTS = [
  /* Deliberately NOT the derived-total point, which the passage above the motto
     makes at length. Two statements of the same fact in one page is how the
     earlier draft came to say five things four times each. This is the other half
     of the same guarantee: corrections are appended, so the history survives. */
  ['Accuracy', 'When an hour is corrected, the correction is added to the record rather than written over it. There is a trail of what changed and when, which means a mistake can be found and fixed instead of quietly becoming the new truth.'],
  ['Plain language', 'The Terms and the Privacy Policy are written to be understood by the fourteen-year-olds who have to agree to them. Where we do not have an answer yet, they say so instead of leaving a gap that reads like an answer.'],
  ['Restraint', 'We ask for the information a volunteer record needs and not more. Student profiles are private by default.'],
  ['Accessibility', 'This should not require a particular device, a particular ability, or a particular kind of attention. We build for keyboards, screen readers, small screens and slow connections, and we treat failures there as defects rather than polish.'],
  ['Care with the sensitive parts', 'We would rather be slow about something involving a minor than quick about something we would have to apologize for.'],
];

export default function AboutUs() {
  /* `/about` is public and renders standalone, but App.jsx's title effect runs
     above its early returns and `tabForPath` has no `/about` branch, so this
     page's tab said "Dashboard · WeVolunteer" for a signed-in reader. Measured
     live: h1 "About WeVolunteer", tab "Dashboard". Same defect as `/verify`;
     see the note in CertificateVerification.jsx. */
  useDocumentTitle('About');
  usePageMeta({ description: 'About WeVolunteer: volunteer sign-ups and verified service hours for students, organizers and schools.' });

  return (
    /* `main`, not a bare div, and `aria-labelledby` pointing at the h1 —
       the same shape LegalCenter uses. `/about` is a PUBLIC route, so it renders
       outside the signed-in shell and nothing above it supplies a landmark: a
       screen-reader user had no main region to jump to and no skip target on the
       one page that explains what this platform is. Every other public view
       already did this; this one was the exception. */
    <main className="content legal-page stack-lg" aria-labelledby="about-title">
      <div className="stack-sm">
        <h1 id="about-title" className="legal-title">About {APP_NAME}</h1>
        {/* Says what the thing IS. An earlier draft opened with a category —
            "a place for people who want to help" — and a table of contents, so a
            parent finished the first screen still not knowing what they were
            looking at. */}
        <p className="about-lead">
          {APP_NAME} is a website for finding volunteer work and keeping an honest
          record of the hours you do. Students use it to find events near them.
          Organizers use it to post those events, see who is coming, and confirm who
          actually showed up.
        </p>
      </div>

      {/* Most readers stop after one screen. This is the difference between a page
          that was published and one that was read. */}
      <section className="about-summary" aria-labelledby="about-summary-heading">
        <h2 id="about-summary-heading" className="about-summary-heading">The short version</h2>
        <ul className="about-summary-list">
          <li>
            We connect students and community members with volunteer opportunities,
            and give organizers the tools to run them.
          </li>
          <li>We started because finding a way to help was harder than it should have been.</li>
          <li>
            Volunteering is about contribution. Hours are just how a contribution gets
            written down.
          </li>
          <li>
            It is new, and it is built and run by one person. That is not a slogan
            about being small — it is who answers when you write in.
          </li>
        </ul>
      </section>

      <div className="about-body">
        <section className="about-section" aria-labelledby="about-mission">
          <h2 id="about-mission">Our mission</h2>
          <p>
            {APP_NAME} exists to make volunteering easier to find, easier to organize,
            and easier to take part in.
          </p>
          <p>
            Underneath that is a simpler idea. Volunteering is not really about
            collecting hours. What actually happens when someone volunteers is that a
            person decides to spend part of their life on something that is not about
            them. A Saturday morning goes to a food drive instead of a screen. An
            afternoon goes to a park cleanup, a tutoring session, a shelter, a
            neighbor.
          </p>
          <p>
            Every hour recorded here stands for a decision somebody made to show up.
            The software only handles the scheduling around that, which is the part
            that tends to get in the way.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-why">
          <h2 id="about-why">Why {APP_NAME} exists</h2>
          <p>
            The gap was never a shortage of people who wanted to help. It was that
            wanting to help and actually helping were separated by a surprising amount
            of friction.
          </p>
          <p>
            Opportunities live in too many places at once. A club announcement here, a
            group chat there, a flyer on a wall, an email thread three weeks old, a
            spreadsheet somebody has to remember to update. That is not anyone's
            fault. It is what happens when coordination is done by whoever has time
            that week.
          </p>
          <p>For someone who wants to volunteer, the questions are basic and often unanswerable:</p>
          <ul>
            <li>What is happening near me, and when?</li>
            <li>What would I actually be doing?</li>
            <li>Is there still space, or was it full a week ago?</li>
            <li>Is this something I would be any good at?</li>
          </ul>
          <p>
            Not knowing is enough to stop someone — not because they stopped caring,
            but because the next step was unclear and something else was clear.
          </p>
          <p>
            Organizers are on the other side of that same problem. They usually know
            exactly what they need and have no dependable way to say it: to reach
            people, keep track of who is coming, know who actually arrived, and finish
            the day with a record they do not have to reconstruct from memory.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-vision">
          <h2 id="about-vision">Our vision</h2>
          <p>
            Convenient sign-ups are worth building. They are not the ambition.
          </p>
          <p>
            What we want is for volunteering to feel like a normal, available part of
            an ordinary week — something you can find when you have a free Saturday,
            the way you can find anything else. Not an exceptional act that requires
            the right connections or the right mailing list, but a visible option.
          </p>
          <p>
            The goal is a community where the distance between “I would help if I knew
            how” and “I helped” is short.
          </p>
        </section>
      </div>

      <section className="stack-md" aria-labelledby="about-beliefs">
        <h2 id="about-beliefs" className="about-heading">What we believe</h2>
        <p className="about-section-lead">
          These are the ones we come back to when deciding what to build and what to
          leave alone.
        </p>
        <ul className="about-belief-list">
          {BELIEFS.map(({ name, body }) => (
            <li key={name} className="about-belief">
              <h3 className="about-belief-name">{name}</h3>
              <p className="about-belief-body">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-md" aria-labelledby="about-audiences">
        <h2 id="about-audiences" className="about-heading">Who this is for</h2>
        <div className="about-audience-grid">
          {AUDIENCES.map(({ key, Icon, title, lead, points }) => (
            <section key={key} className="about-audience" aria-labelledby={`about-${key}`}>
              <div className="about-audience-head">
                <Icon size={20} aria-hidden="true" />
                <h3 id={`about-${key}`}>{title}</h3>
              </div>
              <p className="about-audience-lead">{lead}</p>
              <dl className="about-point-list">
                {points.map(([term, detail]) => (
                  <div key={term} className="about-point">
                    <dt>{term}</dt>
                    <dd>{detail}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        {/**
          * Parents and teachers, who were previously addressed zero times.
          *
          * Most adults who reach this page arrive because a student sent them the
          * link, and the question they came with is not "what is your mission".
          * Every answer below is a fact about the software rather than a promise:
          * profiles are private by default, hours are confirmed by the organizer
          * rather than self-reported, and the Privacy Policy enumerates the fields
          * that are visible to anyone else.
          */}
        <section className="about-audience about-audience-wide" aria-labelledby="about-families">
          <div className="about-audience-head">
            <Users size={20} aria-hidden="true" />
            <h3 id="about-families">For parents and teachers</h3>
          </div>
          <p className="about-audience-lead">
            Most people in this group arrive because a student sent them a link. The
            short answers:
          </p>
          <dl className="about-point-list">
            <div className="about-point">
              <dt>A student profile is private unless they change it</dt>
              <dd>
                Private is the default, not something to go and switch on. The{' '}
                <Link className="policy-link" to="/legal/privacy-policy">Privacy Policy</Link>{' '}
                lists every field anyone else can see, by name.
              </dd>
            </div>
            <div className="about-point">
              <dt>Hours are confirmed by the organizer, not claimed by the student</dt>
              <dd>
                An hour is credited when the person running the event marks the
                volunteer as present. Students can also log outside service
                themselves, and that is recorded separately and labelled as
                self-reported so nobody mistakes one for the other.
              </dd>
            </div>
            <div className="about-point">
              <dt>There is a person to contact</dt>
              <dd>
                Safety concerns and privacy requests reach a human, and the{' '}
                <Link className="policy-link" to="/legal/youth-safety-guidelines">
                  Youth Safety Guidelines
                </Link>{' '}
                describe what we do about them.
              </dd>
            </div>
          </dl>
        </section>
      </section>

      <div className="about-body">
        <section className="about-section" aria-labelledby="about-impact">
          <h2 id="about-impact">Community impact</h2>
          <p>
            Everything that matters about {APP_NAME} happens somewhere we cannot see:
          </p>
          <ul>
            {OUTCOMES.map(outcome => <li key={outcome}>{outcome}</li>)}
          </ul>
          <p>
            A busy week on this website is not the achievement. Events that happened,
            and went well, are.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-commitment">
          <h2 id="about-commitment">Our commitment</h2>
          <p>Five things we intend to hold to as this grows.</p>
          <dl className="about-commitment-list">
            {COMMITMENTS.map(([term, detail]) => (
              <div key={term} className="about-point">
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="about-section" aria-labelledby="about-ahead">
          <h2 id="about-ahead">Looking ahead</h2>
          <p>
            What this becomes should be decided mostly by the people using it — the
            student trying to find something worth a Saturday, the organizer trying to
            run a good event, the school trying to keep an honest record. The most
            useful suggestions we get are somebody describing a problem they had last
            week.
          </p>
          <p>So the plan is to keep listening, keep fixing, and keep the tool out of the way of the work.</p>
        </section>
      </div>

      {/**
        * What the motto cost.
        *
        * The page previously asserted "because we care" after nineteen hundred
        * words in which the only people shown caring were the volunteers. The
        * reader had been given no evidence about us at all, so the closing line
        * was a non sequitur wearing a slogan's clothes.
        *
        * This is the fix: one decision, with a price, that a reader can go and
        * verify. Hours really are derived on every read rather than stored — see
        * `hoursLedger.js` — and a running total really would be simpler to build.
        */}
      <section className="about-earned" aria-labelledby="about-earned-heading">
        <h2 id="about-earned-heading" className="about-heading">What “because we care” has cost</h2>
        <p>
          It is an easy thing to put at the bottom of a page, so here is one place it
          shows up in the work.
        </p>
        <p>
          Your hours are never stored as a total. Every hour is its own record — the
          event, the date, and the organizer who confirmed you were there — and the
          total is added up fresh every time anybody looks at it. Keeping a running
          number would have been faster to build and quicker to load. We do not,
          because a student's record of what they did should never be one bad edit
          away from being wrong.
        </p>
      </section>

      {/**
        * Who runs this.
        *
        * Every legal document on this surface says "we" and "the platform", and
        * nothing anywhere named the account behind those words. A parent
        * deciding whether their child should sign up, or a student who wants to
        * complain to somebody real, could not find out without already having an
        * account — which is backwards, so this page (public, and reached by
        * exactly those people) is where it belongs.
        *
        * The name comes from the server by ROLE, never by matching a username,
        * so an account that changes hands needs no edit here. The title comes
        * from configuration, the same value the transcript footer signs with, so
        * the document and the page cannot disagree about who issued what.
        */}
      <OwnerSection />

      <p className="about-motto">
        <HeartHandshake size={20} aria-hidden="true" />
        <span>{APP_NAME}: because we care.</span>
      </p>

      {/* A footer line rather than a section, so the motto is the last thing said
          and the practical links are still one glance away. */}
      <p className="about-footer-links small">
        <Link className="policy-link" to="/legal">Legal Center</Link>
        {' · '}
        {SUPPORT_EMAIL ? (
          <>
            Something here unclear or wrong? Write to us at{' '}
            <CopyableEmail address={SUPPORT_EMAIL} />
            {' — it goes to one person, and that is who will answer.'}
          </>
        ) : (
          'Contact details for privacy requests and safety reports are at the end of each legal document.'
        )}
      </p>
    </main>
  );
}

/**
 * The platform owner, named.
 *
 * ── Why it renders nothing rather than an error ──
 *
 * A deployment with no owner account yet is a legitimate state — a fresh
 * install, or a district mid-handover — and so is a failed request on a page
 * somebody opened to read prose. Neither is worth a red box on an About page,
 * and the surrounding nineteen hundred words are still true without this. So a
 * miss is silence.
 *
 * ── Why the profile link is not always there ──
 *
 * `/users/@handle` is an APP route, deliberately: "public profile" on this
 * platform means visible to the school community, not to the open internet,
 * because the members are children. A signed-out reader gets the name and the
 * role — which is what they came for — and no link into a members-only surface
 * that would only bounce them to a sign-in screen.
 */
function OwnerSection() {
  const [owner, setOwner] = useState(null);

  /**
   * Whether to offer the profile link, decided WITHOUT a request.
   *
   * This used to call `api.getMe()`. That is authoritative, and on this page it
   * is the wrong trade: `/about` is public and is read mostly by people who have
   * no account — a parent, somebody sent a link — so the call was a guaranteed
   * 401 on almost every view, from anonymous visitors, purely to decide whether
   * to render one anchor.
   *
   * The cached user is enough for that decision and costs nothing. Being wrong
   * is cheap in both directions: a stale cache offers a link to somebody signed
   * out, who meets the sign-in screen the link was always gated by, or withholds
   * it from somebody signed in, who still has the whole navigation. Neither is
   * worth an auth probe on a public page.
   */
  const signedIn = Boolean(api.getCurrentCachedUser?.());

  useEffect(() => {
    let cancelled = false;
    api.fetchPlatformOwner()
      .then(res => { if (!cancelled) setOwner(res?.owner ?? null); })
      .catch(() => { if (!cancelled) setOwner(null); });
    return () => { cancelled = true; };
  }, []);

  if (!owner) return null;

  return (
    <section className="about-section about-owner" aria-labelledby="about-owner-heading">
      <h2 id="about-owner-heading">Who runs {APP_NAME}</h2>
      <div className="about-owner-card">
        {/* The same three lines PublicProfile uses. There is no shared user
            avatar component to reuse — only OrgAvatar, for organizations — and
            inventing one for a single caller would be the wrong moment. */}
        <span
          className="avatar avatar-lg"
          style={avatarColorValue(owner.avatarColor)
            ? { '--avatar-bg': avatarColorValue(owner.avatarColor) }
            : undefined}
          aria-hidden="true"
        >
          {owner.profilePictureUrl
            ? <img src={owner.profilePictureUrl} alt="" className="avatar-img" />
            : (owner.avatar || '🙂')}
        </span>
        <div className="stack-xs">
          <p className="about-owner-name">
            {owner.name}
            {owner.username && <span className="about-owner-handle"> @{owner.username}</span>}
          </p>
          <p className="about-owner-title">
            <Crown size={14} aria-hidden="true" /> {DOCUMENT_SIGNATORY_TITLE}
          </p>
        </div>
      </div>
      <p>
        {APP_NAME} is run by one person, not a company. They are responsible for how
        the platform works, what it does with your information, and every policy in
        the Legal Center. When a document here says &ldquo;we&rdquo;, this is who it
        means, and the signature at the foot of a service transcript is the same
        name.
      </p>
      <p>
        They are also a student who volunteers, so their own service record sits on
        their profile exactly as anybody else&rsquo;s does — the hours there were
        earned the same way and confirmed by the same organizers.
        {signedIn && owner.username && (
          <>
            {' '}
            <Link className="policy-link" to={`/users/@${owner.username}`}>
              See their profile
            </Link>
            .
          </>
        )}
      </p>
    </section>
  );
}
