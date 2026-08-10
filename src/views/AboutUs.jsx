import React from 'react';
import { Link } from 'react-router-dom';
import { Compass, ClipboardList, HeartHandshake } from 'lucide-react';
import { APP_NAME } from '../config';

/**
 * About Us — what WeVolunteer is for, in the words of the people who built it.
 *
 * ── Why this is a written page and not an editable one ──
 *
 * It sits beside the Legal Center in Settings and is reached the same way, so
 * the obvious question is why the owner editor does not manage this too. The
 * answer is that the editor exists for documents that change under pressure —
 * a regulator, a lawyer, a school district — where waiting for a deploy is the
 * problem. Nothing here is like that. This is prose about intent, it changes
 * when the intent changes, and the intent changing is exactly the occasion when
 * a considered edit in a pull request is better than a text box.
 *
 * ── Why it renders on the legal surface's reading scale ──
 *
 * `.legal-page` and the type below come from the reading scale documented in
 * `docs/legal/02-DESIGN-SYSTEM.md`, which exists because the product's type is
 * tuned for scanning dense dashboards and this is two thousand words meant to be
 * read start to finish. Those want opposite settings, and the scale is already
 * built.
 *
 * ── What must not be added here ──
 *
 * No statistics, no partner logos, no claim of nonprofit status, certification,
 * award or institutional endorsement. None of those are established anywhere in
 * this repository, and a page whose whole job is to make the product feel
 * trustworthy is the worst possible place to say something that is not true.
 * Every concrete claim below is either about intent, or is backed by behaviour
 * the software actually has.
 */

/** The principles section. Kept as data so the markup stays one loop. */
const BELIEFS = [
  {
    name: 'Every contribution matters.',
    body: 'Three hours at a single event counts. So does two hundred hours over four '
      + 'years. We are careful not to build anything that quietly ranks people by '
      + 'volume, because the person who came once and stayed the whole time gave '
      + 'something real.',
  },
  {
    name: 'People should be able to find meaningful ways to help.',
    body: 'Discovery is the hardest part of volunteering and the part most often '
      + 'ignored. If someone cannot find an opportunity that fits their time, their '
      + 'area and the things they care about, nothing else we build matters much.',
  },
  {
    name: 'Volunteering is about impact, not just hours.',
    body: 'Hours are a record of participation, not a measure of worth. We track them '
      + 'carefully because schools and programs need them tracked, and we try never '
      + 'to let the number become the reason someone came.',
  },
  {
    name: 'Organizers deserve tools that make their work easier.',
    body: 'Most volunteer coordination is unpaid and invisible. Somebody stays up the '
      + 'night before making the sign-up sheet. Taking work off that person is one of '
      + 'the most useful things a platform like this can do.',
  },
  {
    name: 'Students should have real opportunities to contribute.',
    body: 'A student looking for service hours is usually looking for something more '
      + 'than that: a way to be useful, and a reason to be somewhere that matters. '
      + 'That deserves a better answer than a stale list.',
  },
  {
    name: 'Trust and responsibility matter.',
    body: 'This platform holds records that affect graduation requirements, '
      + 'scholarships and applications. People rely on those records being right. We '
      + 'treat that as an obligation rather than a feature.',
  },
  {
    name: 'Technology should serve people, not get in their way.',
    body: 'The best outcome for our software is that nobody thinks about it. Someone '
      + 'finds an event, signs up, shows up, and gets on with the actual work.',
  },
];

/** The two audiences, side by side, because they are two halves of one problem. */
const AUDIENCES = [
  {
    key: 'volunteers',
    Icon: Compass,
    title: 'For volunteers',
    lead: 'If you are here to volunteer, this should do a few specific things for you.',
    points: [
      ['See what is actually available', 'Real opportunities with real dates, not a list you have to ask someone about.'],
      ['Know what you are signing up for', 'What the work involves, how long it runs, where it is, and what is expected — before you commit. Nobody should arrive to a surprise.'],
      ['Find things that fit', 'Your schedule, your area, and the kind of work you actually want to do. Volunteering you are suited to is volunteering you come back to.'],
      ['Keep an accurate record', 'So when a school, programme or application asks what you have done, the answer is already there and you trust it.'],
      ['Feel that it counted', 'You gave time you were not required to give. That is worth recording properly.'],
    ],
  },
  {
    key: 'organizers',
    Icon: ClipboardList,
    title: 'For organizers',
    lead: 'If you are running events, this is meant to take work off your plate rather than add a system to learn.',
    points: [
      ['Clearer coordination', 'One place your opportunities live, so people can find them without asking you directly.'],
      ['Easier volunteer management', 'Who signed up, how many places are left, who confirmed, and who actually arrived.'],
      ['Real visibility', 'What happened, not just what was planned.'],
      ['Less administrative friction', 'Fewer reminders to send by hand, and less recordkeeping afterwards.'],
      ['A calmer day', 'The point is that you spend the day on the work instead of on the roster.'],
    ],
  },
];

/** What actually changes, none of which happens on this website. */
const OUTCOMES = [
  'A student shows up on a Saturday morning who otherwise would not have known to.',
  'An organizer runs an event that works, because the people who said they were coming came.',
  'A community project gets the number of volunteers it actually needed.',
  'Someone discovers they genuinely like this, and comes back without being asked.',
  'A person feels more connected to the place they live, because they have now done something in it.',
];

const COMMITMENTS = [
  ['Responsibility', 'We hold records people depend on. We take accuracy seriously, and we build so that hours cannot be quietly changed or lost.'],
  ['Transparency', 'We say what we do with information, in language meant to be understood rather than to satisfy a lawyer. Where we do not have an answer yet, we say so instead of leaving a gap that reads like an answer.'],
  ['Respect', "For volunteers' time, organizers' effort, and everyone's privacy. We ask for what we need and not more."],
  ['Accessibility', 'Volunteering should not require a particular device, a particular ability or a particular kind of attention. We build for keyboards, screen readers, small screens and slow connections, and we treat failures there as defects rather than as polish.'],
  ['Trust', 'We would rather move slowly on something sensitive than quickly on something we would have to apologize for.'],
  ['Continuous improvement', 'We expect to be wrong about things. When we are, we would like to find out early and fix it.'],
  ['People before the platform', 'If a decision is good for our numbers and bad for the person in front of it, it is a bad decision.'],
];

export default function AboutUs() {
  return (
    <div className="content legal-page stack-lg">
      <div className="stack-sm">
        <h1 id="about-title" className="legal-title">About {APP_NAME}</h1>
        <p className="about-lead">
          {APP_NAME} is a place for people who want to help and people who need help
          to find each other. This page explains why we built it, who it is for, and
          what we are trying to do.
        </p>
      </div>

      {/* The short version, first, for the reader who stops after one screen —
          the same reasoning the legal surface's SummaryCard is built on. */}
      <section className="about-summary" aria-labelledby="about-summary-heading">
        <h2 id="about-summary-heading" className="about-summary-heading">The short version</h2>
        <ul className="about-summary-list">
          <li>
            We connect students and community members with volunteer opportunities,
            and give organizers the tools to run them.
          </li>
          <li>We started because finding a way to help was harder than it should have been.</li>
          <li>
            We think volunteering is about contribution. Hours are just how
            contribution gets written down.
          </li>
          <li>We are early, and we would rather say that plainly than pretend otherwise.</li>
        </ul>
      </section>

      <div className="about-body">
        <section className="about-section" aria-labelledby="about-mission">
          <h2 id="about-mission">Our mission</h2>
          <p>
            {APP_NAME} exists to make volunteering easier to find, easier to organize,
            and easier to take part in.
          </p>
          <p>That is the practical version. The reason underneath it matters more.</p>
          <p>
            Volunteering is not really about collecting hours. Hours are a record —
            useful, sometimes required, occasionally the reason someone shows up the
            first time. But what actually happens when someone volunteers is that a
            person decides to spend part of their life on something that is not about
            them. A Saturday morning goes to a food drive instead of a screen. An
            afternoon goes to a park cleanup, a tutoring session, a shelter, a
            neighbor.
          </p>
          <p>
            Communities are not strong because of the institutions inside them. They
            are strong because enough people care enough to take part. Every hour
            recorded here stands for a decision somebody made to show up.
          </p>
          <p>
            We built a tool for the logistics. The logistics are not the point. They
            are what gets in the way of the point.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-why">
          <h2 id="about-why">Why {APP_NAME} exists</h2>
          <p>
            The gap we kept running into was not a shortage of people who wanted to
            help. It was that wanting to help and actually helping were separated by a
            surprising amount of friction.
          </p>
          <p>
            Opportunities live in too many places at once. A club announcement here, a
            group chat there, a flyer on a wall, an email thread three weeks old, a
            spreadsheet somebody has to remember to update. None of that is anyone's
            fault. It is what happens when coordination is done by whoever has time
            that week.
          </p>
          <p>For someone who wants to volunteer, the questions are basic and often unanswerable:</p>
          <ul>
            <li>What opportunities actually exist right now?</li>
            <li>When are they, and can I make it?</li>
            <li>What would I be doing, and do I need to bring or know anything?</li>
            <li>Is there still space, or was it full a week ago?</li>
            <li>Is this something I would be any good at, or care about?</li>
          </ul>
          <p>
            Not knowing is enough to stop most people — not because they stopped
            caring, but because the next step was unclear and something else was
            clear.
          </p>
          <p>
            Organizers have the opposite problem, and it is just as real. They usually
            know exactly what they need. What they lack is a dependable way to say so:
            to reach the right people, keep track of who is coming, know who actually
            arrived, and end up with an accurate record without spending the week
            before the event sending reminders one at a time.
          </p>
          <p>
            Both sides want the same event to happen. {APP_NAME} is meant to be the
            bridge between them.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-vision">
          <h2 id="about-vision">Our vision</h2>
          <p>
            Making sign-ups more convenient is worth doing, but it is not the
            ambition.
          </p>
          <p>
            What we want is for volunteering to feel like a normal, available part of
            ordinary life — something you can find when you have a free Saturday, the
            way you can find anything else. Not an exceptional act that requires the
            right connections or the right mailing list, but a visible option.
          </p>
          <p>
            When opportunities are easy to see, more people take them. When organizers
            can rally people quickly and reliably, they attempt more. When
            participation is easy to record honestly, the people who did the work get
            credit for it.
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
          These are the principles we come back to when we are deciding what to build
          and what to leave alone.
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
      </section>

      <div className="about-body">
        <section className="about-section" aria-labelledby="about-impact">
          <h2 id="about-impact">Community impact</h2>
          <p>The important thing about {APP_NAME} happens somewhere we cannot see.</p>
          <p>
            The website is a tool. What it does is arrange a meeting. The result is
            somewhere else:
          </p>
          <ul>
            {OUTCOMES.map(outcome => <li key={outcome}>{outcome}</li>)}
          </ul>
          <p>
            We do not measure ourselves by activity on the platform. We measure
            ourselves by whether events happened, and whether they went well.
          </p>
          <p>
            If this worked perfectly, you would barely notice it. You would notice
            that more got done.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-commitment">
          <h2 id="about-commitment">Our commitment</h2>
          <p>
            {APP_NAME} is early, and we would rather be honest about that than
            impressive about it. Here is what we intend to hold to as it grows.
          </p>
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
          <p>We do not think {APP_NAME} is finished. We think it is started.</p>
          <p>
            What it becomes should be decided largely by the people actually using it —
            the students trying to find something worth their Saturday, the organizers
            trying to run a good event, the schools trying to keep an honest record.
            The best ideas about what to build next tend to arrive as somebody
            describing a problem they had last week.
          </p>
          <p>
            So we intend to keep listening, keep fixing, and keep the tool out of the
            way of the work.
          </p>
          <p>It all comes back to one simple reason.</p>
        </section>
      </div>

      {/* The motto, given its own block rather than trailing a paragraph. It is
          the one line on this page a reader is meant to remember. */}
      <p className="about-motto">
        <HeartHandshake size={20} aria-hidden="true" />
        <span>{APP_NAME}: because we care.</span>
      </p>

      <section className="stack-sm" aria-labelledby="about-next">
        <h2 id="about-next" className="about-heading">Where to go next</h2>
        {/* Not `small dim`. This is the one sentence on the page a reader is
            meant to act on, and --ink-3 is reserved for things nobody has to. */}
        <p className="about-section-lead">
          The <Link className="policy-link" to="/legal">Legal Center</Link> holds everything we ask you to
          agree to and everything we promise in return — the Terms, the Privacy
          Policy, and the safety guidelines. If something here or there is unclear,
          that is worth telling us.
        </p>
      </section>
    </div>
  );
}
