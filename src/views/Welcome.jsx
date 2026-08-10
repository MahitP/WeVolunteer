import React from 'react';
import { useNavigate } from 'react-router-dom';
import { APP_NAME, SCHOOL_NAME, PRIVACY_URL } from '../config';
import { ArrowRight, Search, CalendarCheck, Award, Lock } from 'lucide-react';
import BrandMark from '../components/common/BrandMark';

/**
 * What the three things the product actually does are, in the order a student
 * meets them. The previous screen said "Find opportunities. Help your
 * community. Track your impact." — true of every volunteering product ever
 * made, and it left a first-time visitor with no idea whether this was their
 * school's system, who could see their information, or what signing up
 * committed them to.
 */
const POINTS = [
  {
    icon: Search,
    title: 'Find shifts near you',
    desc: 'Browse opportunities posted by your school and local organizations.'
  },
  {
    icon: CalendarCheck,
    title: 'Apply in a couple of taps',
    desc: 'Pick a shift that fits your schedule. Organizers confirm who attends.'
  },
  {
    icon: Award,
    title: 'Get your hours verified',
    desc: 'Attendance is confirmed by the organizer, so your service record counts.'
  }
];

export default function Welcome() {
  const navigate = useNavigate();

  /**
   * SCHOOL_NAME defaults to "WeVolunteer Community" when a district has not
   * set VITE_SCHOOL_NAME, which made the sentence read "WeVolunteer is how
   * WeVolunteer Community posts volunteer shifts…". Fall back to a phrasing
   * that does not name an organisation rather than one that names it twice.
   */
  const named = SCHOOL_NAME && !SCHOOL_NAME.includes(APP_NAME);
  const intro = named
    ? `${APP_NAME} is how ${SCHOOL_NAME} posts volunteer shifts and keeps track of service hours — in one place, verified by the people running each event.`
    : `${APP_NAME} is where your school and local organizations post volunteer shifts, and where your service hours are kept — verified by the people running each event.`;

  return (
    <div className="auth">
      <main className="auth-form auth-centered" aria-labelledby="welcome-heading">
        <BrandMark size="lg" />

        <div className="auth-head" style={{ marginTop: 'var(--s6)' }}>
          <h1 id="welcome-heading" className="auth-title">Volunteering, organized.</h1>
          <p className="auth-subtitle">{intro}</p>
        </div>

        <div className="auth-actions stack-sm">
          <button
            className="btn btn-primary btn-lg btn-block"
            onClick={() => navigate('/signup')}
          >
            <span>Create an account</span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>

          <button
            className="btn btn-secondary btn-lg btn-block"
            onClick={() => navigate('/login')}
          >
            I already have an account
          </button>
        </div>

        <ul className="welcome-points">
          {POINTS.map(({ icon: Icon, title, desc }) => (
            <li key={title} className="welcome-point">
              <span className="welcome-point-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span>
                <span className="welcome-point-title">{title}</span>
                <span className="welcome-point-desc">{desc}</span>
              </span>
            </li>
          ))}
        </ul>

        {/*
          Trust matters more here than on a consumer product: the people signing
          up are mostly minors, and the adults deciding whether they may are
          parents and school staff. Saying plainly who runs this and where the
          privacy notice is costs one line and answers the first question both
          of them have. The privacy link renders only when the district has
          supplied a real URL — a dead link would be worse than none.
        */}
        <p className="welcome-trust">
          {named && (
            <span className="welcome-trust-row">
              <Lock size={13} aria-hidden="true" />
              <span>Run by {SCHOOL_NAME}</span>
            </span>
          )}
          {PRIVACY_URL ? (
            <>
              Your information is only shared with the organizers of shifts you apply to.{' '}
              <a className="auth-link" href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
                Read the privacy notice
              </a>
            </>
          ) : (
            'Your information is only shared with the organizers of shifts you apply to.'
          )}
        </p>
      </main>
    </div>
  );
}
