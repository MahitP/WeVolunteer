import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { Users, Clock, CalendarCheck, Building2, TrendingUp, MapPin, Sprout } from 'lucide-react';

/**
 * The community impact page.
 *
 * ── Who this is written for ──
 *
 * Three readers at once: a student attaching a number to a college application,
 * an organizer writing a grant report, and a parent deciding whether this thing
 * is real. All three need the figures to be defensible rather than flattering,
 * which is why the page says what each number counts rather than leaving a bare
 * total to be read generously.
 *
 * "1,240 hours" invites the question "hours of what, claimed by whom". "1,240
 * hours confirmed by an organizer after the shift" answers it in the same
 * breath, and that sentence is the difference between a figure somebody quotes
 * and a figure somebody checks and then stops trusting.
 *
 * ── The suppression footnote is not decoration ──
 *
 * Buckets below the server's threshold come back with a null count and
 * `suppressed: true`. They are rendered as withheld rather than dropped, and the
 * page explains why once, plainly: a reader who sees a gap and no explanation
 * assumes a bug, and a reader who sees no gap at all assumes they have the whole
 * picture. Neither is true.
 */

const nf = new Intl.NumberFormat();

/** A headline figure and, more importantly, what it counts. */
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

/**
 * A horizontal bar row.
 *
 * Bars are scaled against the largest VISIBLE value, not against the total: a
 * suppressed bucket has no value to contribute, so scaling against a total that
 * silently includes it would make every visible bar too short by an unknown
 * amount and quietly misstate the comparison the chart exists to support.
 */
function Bar({ label, value, max, suffix, suppressed }) {
  if (suppressed) {
    return (
      <div className="impact-bar-row impact-bar-suppressed">
        <span className="impact-bar-label">{label}</span>
        <span className="impact-bar-track" aria-hidden="true" />
        <span className="impact-bar-value">Withheld</span>
      </div>
    );
  }
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="impact-bar-row">
      <span className="impact-bar-label">{label}</span>
      <span className="impact-bar-track">
        <span className="impact-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="impact-bar-value">{nf.format(value)}{suffix}</span>
    </div>
  );
}

export default function ImpactDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.fetchImpact()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div className="page">
        <header className="page-head"><h1>Community impact</h1></header>
        <EmptyState
          icon={Sprout}
          title="Couldn't load the figures"
          message="The request did not come back. Nothing has changed — try again."
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <header className="page-head"><h1>Community impact</h1></header>
        <LoadingSkeleton heights={[120, 200, 200]} />
      </div>
    );
  }

  const { community, growth, volunteers, categories, geography, minBucket } = data;
  const hasAnything = community.totalVolunteers > 0;

  const catMax = Math.max(0, ...categories.filter(c => !c.suppressed).map(c => c.hours ?? 0));
  const growthMax = Math.max(0, ...growth.filter(g => !g.suppressed).map(g => g.hours ?? 0));
  const anySuppressed = [...categories, ...growth].some(b => b.suppressed);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Community impact</h1>
        <p className="muted">
          What this community has actually done — counted from confirmed attendance,
          never from sign-ups.
        </p>
      </header>

      {!hasAnything ? (
        <EmptyState
          icon={Sprout}
          title="Nothing to show yet"
          message="These figures start counting once volunteers have attended their first shifts and an organizer has confirmed the hours."
        />
      ) : (
        <div className="stack-lg">
          <section aria-labelledby="impact-community">
            <div className="section-head"><h2 id="impact-community">The community</h2></div>
            <div className="impact-figures">
              <Figure
                icon={Users} value={nf.format(community.totalVolunteers)}
                label="Volunteers" note="People who turned up, not sign-ups"
              />
              <Figure
                icon={Clock} value={nf.format(community.totalHours)}
                label="Hours served" note="Confirmed by an organizer after the shift"
              />
              <Figure
                icon={CalendarCheck} value={nf.format(community.eventsCompleted)}
                label="Events completed" note="Events somebody actually attended"
              />
              <Figure
                icon={Building2} value={nf.format(community.organizationsSupported)}
                label="Organizations" note="Groups this community showed up for"
              />
            </div>
          </section>

          <section aria-labelledby="impact-volunteers">
            <div className="section-head"><h2 id="impact-volunteers">How people take part</h2></div>
            <div className="impact-figures">
              <Figure
                icon={Clock} value={volunteers.averageHours ?? '—'}
                label="Average hours" note="Per volunteer"
              />
              {/* The median sits beside the mean so a reader can tell a broad
                  programme from a narrow one with a star: one volunteer with 200
                  hours drags an average nobody in the room would recognise. */}
              <Figure
                icon={Clock} value={volunteers.medianHours ?? '—'}
                label="Median hours" note="The typical volunteer"
              />
              <Figure
                icon={TrendingUp}
                value={volunteers.returningRate === null ? '—' : `${volunteers.returningRate}%`}
                label="Came back" note="Volunteered at a second, different event"
              />
              <Figure
                icon={MapPin} value={nf.format(geography.distinctLocations)}
                label="Places served" note="Distinct locations, counted only"
              />
            </div>
          </section>

          {categories.length > 0 && (
            <section aria-labelledby="impact-categories">
              <div className="section-head"><h2 id="impact-categories">Where the effort went</h2></div>
              <div className="impact-bars">
                {categories.map((c) => (
                  <Bar
                    key={c.label} label={c.label} value={c.hours ?? 0} max={catMax}
                    suffix=" hrs" suppressed={c.suppressed}
                  />
                ))}
              </div>
            </section>
          )}

          {growth.length > 0 && (
            <section aria-labelledby="impact-growth">
              <div className="section-head"><h2 id="impact-growth">Month by month</h2></div>
              <div className="impact-bars">
                {growth.map((g) => (
                  <Bar
                    key={g.month} label={g.month} value={g.hours ?? 0} max={growthMax}
                    suffix=" hrs" suppressed={g.suppressed}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Explained once, plainly. A reader who sees a gap and no explanation
              assumes a bug; a reader who sees no gap assumes they have the whole
              picture. Neither is true, and the second is worse. */}
          {anySuppressed && (
            <p className="muted impact-note">
              Some rows read <strong>Withheld</strong>. Anything covering fewer than{' '}
              {minBucket} volunteers is held back, because a figure about a very small
              group can identify the people in it — and most of them are under 18.
              The totals above still include them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
