import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Clock, CalendarCheck, Building2, Repeat, Loader2 } from 'lucide-react';
import BrandMark from '../components/common/BrandMark';
import { api } from '../utils/api';
import { APP_NAME, SCHOOL_NAME } from '../config';

/**
 * The community figures, for people without an account.
 *
 * ── Who this is for ──
 *
 * A grant reviewer, a district administrator, a parent deciding whether this is
 * a real programme. None of them will create an account to look at a number, and
 * a link that asks them to is a link they close. That is the entire reason this
 * page exists separately from `/impact`.
 *
 * ── Why it is deliberately small ──
 *
 * It shows four totals and one rate. The signed-in dashboard also breaks the
 * figures down by category, by month and by place, and none of that is here:
 * every breakdown is a way of asking about a smaller group, and this page is read
 * by anybody at all — including somebody who already knows things about a
 * particular school and is looking for one more number to line them up against.
 * The server enforces this rather than trusting the page: `/api/public/impact`
 * builds its own payload and names the fields it emits.
 *
 * ── Every figure says what it counts ──
 *
 * "318 hours" invites "hours of what, claimed by whom", and a page that leaves
 * that unanswered is one somebody quotes once and then stops trusting. The
 * definitions arrive in the payload rather than being written here, so the
 * sentence cannot drift from the query that produced the number.
 */

const nf = new Intl.NumberFormat();

/** Same markup as the signed-in dashboard's figures — one visual language. */
function Figure({ icon: Icon, value, label, note }) {
  return (
    <div className="impact-figure">
      <span className="impact-figure-icon" aria-hidden="true"><Icon size={18} /></span>
      <span className="impact-figure-value">{value}</span>
      <span className="impact-figure-label">{label}</span>
      {note && <span className="impact-figure-note">{note}</span>}
    </div>
  );
}

export default function PublicImpact() {
  const [state, setState] = useState({ status: 'loading', data: null });

  useEffect(() => {
    let cancelled = false;
    api.fetchPublicImpact()
      .then(data => { if (!cancelled) setState({ status: 'ready', data }); })
      .catch(() => { if (!cancelled) setState({ status: 'error', data: null }); });
    return () => { cancelled = true; };
  }, []);

  const { status, data } = state;
  const d = data?.definitions ?? {};

  return (
    <div className="public-page">
      <header className="topbar" style={{ justifyContent: 'center' }}>
        <Link className="brand" to="/">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-name">{APP_NAME}</span>
            <span className="brand-sub">Community impact</span>
          </span>
        </Link>
      </header>

      <main className="public-main">
        <div className="stack-lg" style={{ width: '100%', maxWidth: 720 }}>
          <div>
            <h1>What this community has done</h1>
            <p className="lead">
              Every figure below is counted from confirmed attendance at {SCHOOL_NAME} —
              somebody turned up, and an organizer confirmed it. Sign-ups are never counted.
            </p>
          </div>

          {status === 'loading' && (
            <div className="stack-sm" style={{ alignItems: 'center', padding: 'var(--s6) 0' }}>
              <Loader2 size={28} className="spin" style={{ color: 'var(--ink-3)' }} />
              <p className="dim">Counting…</p>
            </div>
          )}

          {/**
            * An unreachable server must not be reported as "no impact".
            *
            * The failure modes look identical on screen if you are careless — an
            * empty page and a page of zeros both read as "this programme does
            * nothing" — and only one of them is a claim about the community.
            */}
          {status === 'error' && (
            <div className="alert alert-danger" role="alert">
              These figures could not be loaded right now. That is a problem on our side and
              says nothing about the programme — please try again shortly.
            </div>
          )}

          {status === 'ready' && !data.available && (
            <div className="card card-pad">
              <p className="lead">Not published yet</p>
              <p className="dim">{data.reason}</p>
            </div>
          )}

          {status === 'ready' && data.available && (
            <>
              <div className="impact-figures">
                <Figure
                  icon={Users}
                  value={nf.format(data.community.totalVolunteers)}
                  label="Volunteers"
                  note={d.totalVolunteers}
                />
                <Figure
                  icon={Clock}
                  value={nf.format(data.community.totalHours)}
                  label="Hours served"
                  note={d.totalHours}
                />
                <Figure
                  icon={CalendarCheck}
                  value={nf.format(data.community.eventsCompleted)}
                  label="Events completed"
                  note={d.eventsCompleted}
                />
                <Figure
                  icon={Building2}
                  value={nf.format(data.community.organizationsSupported)}
                  label="Organizations supported"
                  note={d.organizationsSupported}
                />
              </div>

              <div className="card card-pad">
                <Figure
                  icon={Repeat}
                  value={`${data.participation.returningRate}%`}
                  label="Came back for more"
                  note={d.returningRate}
                />
              </div>

              {/**
                * The methodology, stated plainly rather than linked.
                *
                * A reader deciding whether to quote a number wants to know what it
                * excludes, and putting that a click away means most of them quote
                * it without knowing. It is four sentences; it can just be here.
                */}
              <section className="card card-pad stack-sm">
                <h2>How these are counted</h2>
                <p className="small dim">
                  Hours are credited only after an organizer confirms that somebody was
                  present, and a credited hour is never re-priced afterwards. A volunteer is
                  counted once however many shifts they work. "Came back for more" counts a
                  second, different event — two shifts at one event is one commitment.
                </p>
                <p className="small dim">
                  Nothing here is broken down by school, neighbourhood, category or person.
                  Most of the people behind these numbers are minors, and a figure about a
                  small enough group stops being a figure about a group. Figures are not
                  published at all until at least {data.minBucket} volunteers have taken part.
                </p>
              </section>
            </>
          )}

          <p className="small dim">
            <Link to="/">Back to {APP_NAME}</Link>
            {' · '}
            <Link to="/legal">Terms, privacy and safety policies</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
