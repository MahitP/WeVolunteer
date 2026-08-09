/**
 * Platform Impact — the owner's view of how the programme is actually doing.
 *
 * ── Why this is not the page it replaced ──
 *
 * It began as `PublicImpact`, rendered at `/community` with no session, and its
 * first move to `/admin/impact` kept the public payload: four totals, one rate,
 * and a bar chart comparing volunteers to events to organizations — three
 * quantities in three different units, on one axis. The source comment
 * acknowledged that this "doesn't make perfect analytical sense since units
 * differ, but fits the 'cool UI' graph request".
 *
 * A chart that compares incomparable things is worse than no chart: it is read,
 * and what it says is false. Both charts here plot ONE quantity against ONE
 * axis — hours against months, hours against categories — which is the only
 * reason either is worth drawing.
 *
 * ── Where the extra data came from ──
 *
 * Not from a relaxed gate. `analytics.platform` is SUPER_ONLY, and a super_admin
 * holds `'*'`, so every figure below was already readable at `/api/impact` (which
 * answers `analytics.impact`, now an administrative capability rather than one
 * every signed-in role holds — the wildcard is what carries this argument, and it
 * is unaffected). See the note on `buildAdminImpact` in server/impact.js: this
 * audience is strictly narrower than one that already sees the same payload.
 *
 * ── Suppressed buckets are DRAWN, not dropped ──
 *
 * `MIN_BUCKET` hides a month or a category with fewer than five volunteers,
 * because a bucket of two is a description of two children. The server returns
 * those with `suppressed: true` and a null count rather than omitting them, and
 * this page renders the gap and says why. A reader who sees eleven months and
 * eight bars knows something was withheld; a reader who sees eight months
 * believes that is all there is.
 *
 * ── The export builds an SVG; it does not photograph the page ──
 *
 * The previous revision added `html2canvas` for this. That dependency is
 * removed, for four reasons, in ascending order of importance:
 *   1. ~200 kB, last published 2022, for one button.
 *   2. It re-implements a CSS renderer, so what it captures is an approximation
 *      of what the reader saw, and the failure mode is a silently wrong image.
 *   3. It photographs the LIVE DOM, so the snapshot inherits scroll position,
 *      hover states and whatever the fonts happened to do.
 *   4. Theme fidelity was the actual requirement, and rasterising the page makes
 *      that a hope. `snapshotSvg` below reads the resolved token values out of
 *      the live document and writes them into the SVG as literals, so the export
 *      is dark when the app is dark BECAUSE it was told the colour, not because
 *      a screenshot happened to catch it.
 *
 * It also touches no CSS. There is no print stylesheet involvement here at all,
 * which matters because this application already prints certificates and
 * transcripts (`@media print` in index.css) and an export mechanism that reached
 * for those rules could break a student's service record.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Users, Clock, CalendarCheck, Building2, Download, MapPin, Repeat } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { SCHOOL_NAME } from '../config';

const nf = new Intl.NumberFormat();
/* Compact only above 10,000. Below that "9,900" is shorter to read than "9.9K"
   and does not ask the reader to expand an abbreviation to compare two bars. */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const axisNumber = (n) => (n >= 10000 ? compact.format(n) : nf.format(n));

/** "2026-03" → "Mar 2026". Parsed as UTC so a month never shifts by a timezone. */
function monthLabel(month) {
  const [y, m] = String(month).split('-');
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  if (Number.isNaN(date.getTime())) return String(month);
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const formatHours = (n) => `${nf.format(Math.round(Number(n) || 0))}`;

/* ── Figures ─────────────────────────────────────────────────────────────── */

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

/* ── Charts ──────────────────────────────────────────────────────────────── */

/**
 * Hours credited, by month.
 *
 * An area with a line on top, one series, one axis. No legend — the heading
 * names the series, and a legend box for a single series is furniture.
 *
 * Every branch below exists because the data really does arrive that way:
 *   - **No months at all** on a programme that has credited nothing yet.
 *   - **One month**, where a polyline has nothing to interpolate and would
 *     render as an invisible zero-length path. Drawn as a single marker.
 *   - **A flat series** (every month equal, including all-zero), where the
 *     natural `max - min` denominator is zero and every point divides by it.
 *   - **A suppressed month**, which has hours but no publishable volunteer
 *     count. It keeps its place on the axis so the time series stays evenly
 *     spaced; dropping it would silently compress the timeline.
 */
function HoursByMonth({ months }) {
  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 12, bottom: 28, left: 44 };

  const points = months.map(m => ({ month: m.month, hours: Number(m.hours) || 0 }));
  const max = Math.max(...points.map(p => p.hours), 1);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (i) => (points.length === 1
    ? PAD.left + plotW / 2
    : PAD.left + (i / (points.length - 1)) * plotW);
  const y = (v) => PAD.top + plotH - (v / max) * plotH;

  /* Four gridlines including zero. Values are rounded for the label but the
     line is drawn at the true fraction, so the grid never lies about scale. */
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ f, value: max * f }));

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.hours)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`;

  const total = points.reduce((s, p) => s + p.hours, 0);
  const summary = `Hours credited by month, ${monthLabel(points[0].month)} to `
    + `${monthLabel(points[points.length - 1].month)}. ${formatHours(total)} hours in total. `
    + `Highest month ${formatHours(max)} hours.`;

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      /* `meet`, not `none`. Stretching the viewBox to the container's aspect
         ratio scales x and y independently, and the axis labels are inside the
         viewBox — so on any container wider than 720 the numbers came out
         horizontally smeared. The chart now scales proportionally and the CSS
         gives it `height: auto` to match. */
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={summary}
    >
      {ticks.map(({ f, value }) => (
        <g key={f}>
          <line
            className="chart-grid"
            x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + plotH - f * plotH} y2={PAD.top + plotH - f * plotH}
          />
          <text
            className="chart-axis-text"
            x={PAD.left - 8} y={PAD.top + plotH - f * plotH}
            textAnchor="end" dominantBaseline="middle"
          >
            {axisNumber(Math.round(value))}
          </text>
        </g>
      ))}

      {points.length > 1 && <path className="chart-area" d={area} />}
      {points.length > 1 && <path className="chart-line" d={line} />}

      {points.map((p, i) => (
        /* A marker on every point, not a label on every point. `<title>` is the
           browser's own tooltip and is read by assistive technology, so the
           hover layer costs no JavaScript and no dependency. */
        <circle
          key={p.month}
          className="chart-dot"
          cx={x(i)} cy={y(p.hours)}
          r={points.length > 24 ? 2.5 : 4}
        >
          <title>{`${monthLabel(p.month)}: ${formatHours(p.hours)} hours`}</title>
        </circle>
      ))}

      {/* First, middle and last month only. One label per point collides on any
          series longer than about eight months and on every phone. */}
      {[0, Math.floor((points.length - 1) / 2), points.length - 1]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map(i => (
          <text
            key={i}
            className="chart-axis-text"
            x={x(i)} y={H - 8}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
          >
            {monthLabel(points[i].month)}
          </text>
        ))}
    </svg>
  );
}

/**
 * Where the effort went — hours by category, as horizontal bars.
 *
 * Ordered by hours (the server already does this), because the question is
 * "where did the effort go" and a category of many short shifts is not a bigger
 * need than one of a few long ones.
 *
 * Bars are labelled directly with their value; there is no value axis, because
 * with the number at the end of every bar an axis would be a second copy of the
 * same information.
 */
function HoursByCategory({ categories }) {
  const rows = categories.filter(c => Number(c.hours) > 0);
  const max = Math.max(...rows.map(c => Number(c.hours) || 0), 1);

  return (
    <ul className="chart-bars">
      {rows.map((c) => {
        const hours = Number(c.hours) || 0;
        /* A floor of 1.5% so a real but tiny value is still a visible mark
           rather than nothing. It is a floor on the DRAWING only — the number
           beside it is exact, so the bar cannot overstate the value it labels. */
        const pct = Math.max(1.5, (hours / max) * 100);
        return (
          <li key={c.label} className="chart-bar-row">
            <span className="chart-bar-label">{c.label}</span>
            <span className="chart-bar-track">
              <span className="chart-bar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="chart-bar-value">
              {formatHours(hours)}
              <span className="chart-bar-unit"> h</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ── The snapshot ────────────────────────────────────────────────────────── */

/**
 * Reads a design token's RESOLVED value out of the live document.
 *
 * The export has to look like what the reader is looking at, and the reader's
 * theme is whatever `[data-theme]` currently resolves these to. Reading them
 * here rather than hardcoding a light and a dark palette is what makes the
 * export follow the theme automatically, including any theme added later.
 */
function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * A self-contained SVG of the headline figures, in the current theme.
 *
 * Deliberately the FIGURES rather than the whole page. A snapshot is something
 * somebody pastes into an email or a grant application, and a tall screenshot of
 * a scrolling dashboard is not that. Everything here is drawn from the same
 * `data` object the page rendered, so the two cannot disagree.
 */
function snapshotSvg(data, title) {
  /* The fallbacks are CSS SYSTEM colours, not a hardcoded light palette.
     `index.css` defines all five tokens, so the fallback should never be
     reached — but if one is ever renamed, `canvas`/`canvastext` degrade to the
     reader's own platform theme, which is still dark for a dark-mode reader.
     A hex fallback would silently produce a light-themed export instead, which
     is precisely the failure this export exists to avoid. */
  const ink = token('--ink', 'canvastext');
  const ink3 = token('--ink-3', 'graytext');
  const brand = token('--brand', 'linktext');
  const surface = token('--surface', 'canvas');
  const rule = token('--rule', 'graytext');

  const c = data.community;
  const v = data.volunteers ?? {};
  const cells = [
    [nf.format(c.totalVolunteers), 'Volunteers'],
    [nf.format(Math.round(c.totalHours)), 'Hours served'],
    [nf.format(c.eventsCompleted), 'Events completed'],
    [nf.format(c.organizationsSupported), 'Organizations'],
  ];
  if (v.returningRate !== null && v.returningRate !== undefined) {
    cells.push([`${v.returningRate}%`, 'Came back for more']);
  }

  const W = 900;
  const cols = Math.min(cells.length, 3);
  const rowsN = Math.ceil(cells.length / cols);
  const CELL_H = 118;
  const H = 150 + rowsN * CELL_H + 46;
  const cellW = (W - 96) / cols;

  const cellSvg = cells.map(([value, label], i) => {
    const cx = 48 + (i % cols) * cellW;
    const cy = 150 + Math.floor(i / cols) * CELL_H;
    return `
    <text x="${cx}" y="${cy + 44}" fill="${brand}" font-size="40" font-weight="700"
          font-family="Helvetica, Arial, sans-serif">${escapeXml(value)}</text>
    <text x="${cx}" y="${cy + 72}" fill="${ink3}" font-size="15"
          font-family="Helvetica, Arial, sans-serif">${escapeXml(label)}</text>`;
  }).join('');

  const generated = new Date(data.generatedAt || Date.now()).toLocaleString();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${surface}"/>
  <text x="48" y="72" fill="${ink}" font-size="30" font-weight="700"
        font-family="Helvetica, Arial, sans-serif">${escapeXml(title)}</text>
  <text x="48" y="104" fill="${ink3}" font-size="16"
        font-family="Helvetica, Arial, sans-serif">${escapeXml(SCHOOL_NAME)}</text>
  <line x1="48" y1="128" x2="${W - 48}" y2="128" stroke="${rule}" stroke-width="1"/>
  ${cellSvg}
  <text x="48" y="${H - 22}" fill="${ink3}" font-size="13"
        font-family="Helvetica, Arial, sans-serif">Generated ${escapeXml(generated)} · Hours are credited only after an organizer confirms attendance.</text>
</svg>`;
}

function triggerDownload(href, filename) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * SVG → PNG through a canvas, falling back to the SVG file itself.
 *
 * PNG because the destination is usually an email or a document, and an SVG
 * attachment is the kind of file somebody has to be told how to open. The
 * fallback is not defensive padding: `canvas.toDataURL` throws on a tainted
 * canvas, and rather than tell somebody their snapshot failed, handing them the
 * vector — which is the better file anyway — costs nothing.
 */
async function downloadSnapshot(svg, filename) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const png = await new Promise((resolve, reject) => {
      const img = new Image();
      /**
       * A deadline, because "neither handler fires" is a real state.
       *
       * `onload`/`onerror` are the only two ways out of this promise, and an
       * environment that never fires either — a stalled decode, a blob URL the
       * platform will not load — leaves it pending for ever. The visible
       * symptom is the worst kind: the button does nothing, no error, and the
       * `finally` that revokes the object URL never runs, so every press leaks
       * one. Settling by rejection sends it down the SVG fallback, which is a
       * working download rather than silence.
       */
      const deadline = setTimeout(() => reject(new Error('snapshot rasterising timed out')), 5000);
      img.onload = () => {
        clearTimeout(deadline);
        try {
          const canvas = document.createElement('canvas');
          /* 2× so the figures stay sharp when the image is dropped into a
             document at its natural size and then printed. */
          canvas.width = img.naturalWidth * 2;
          canvas.height = img.naturalHeight * 2;
          const ctx = canvas.getContext('2d');
          ctx.scale(2, 2);
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) { reject(err); }
      };
      img.onerror = () => { clearTimeout(deadline); reject(new Error('snapshot image failed to load')); };
      img.src = url;
    });
    triggerDownload(png, `${filename}.png`);
  } catch {
    triggerDownload(url, `${filename}.svg`);
  } finally {
    /* Revoked either way — the object URL outlives the click otherwise, and on
       a dashboard somebody leaves open all afternoon that is a leak per press. */
    URL.revokeObjectURL(url);
  }
}

/* ── The page ────────────────────────────────────────────────────────────── */

export default function AdminImpact({ addToast }) {
  const [state, setState] = useState({ status: 'loading', data: null });

  useEffect(() => {
    let cancelled = false;
    api.fetchAdminImpact()
      .then(data => { if (!cancelled) setState({ status: 'ready', data }); })
      .catch(() => { if (!cancelled) setState({ status: 'error', data: null }); });
    return () => { cancelled = true; };
  }, []);

  const { status, data } = state;
  const d = data?.definitions ?? {};

  const months = useMemo(() => (data?.growth ?? []), [data]);
  const publishedMonths = months.filter(m => Number(m.hours) > 0);
  const suppressedMonths = months.filter(m => m.suppressed).length;
  const categories = useMemo(() => (data?.categories ?? []), [data]);
  const suppressedCategories = categories.filter(c => c.suppressed).length;
  const hasCategoryHours = categories.some(c => Number(c.hours) > 0);
  /* The tag breakdown is an object, not an array — it carries `overlapping`
     alongside its buckets. See the note on `tags()` in server/impact.js. */
  const tagBreakdown = useMemo(() => (data?.tags?.breakdown ?? []), [data]);
  const suppressedTags = tagBreakdown.filter(t => t.suppressed).length;

  const onDownload = async () => {
    try {
      await downloadSnapshot(snapshotSvg(data, 'Platform Impact'), 'platform-impact');
    } catch {
      addToast?.('Could not build the snapshot image.', 'error');
    }
  };

  return (
    <div className="page">
      <header className="page-head impact-head">
        <div>
          <h1>Platform Impact</h1>
          <p className="lead">
            Programme-wide figures for {SCHOOL_NAME}, counted from confirmed attendance.
          </p>
        </div>
        {status === 'ready' && (
          <button type="button" className="btn btn-secondary" onClick={onDownload}>
            <Download size={16} aria-hidden="true" />
            <span>Download snapshot</span>
          </button>
        )}
      </header>

      {/* `aria-live` so the outcome of the fetch is announced rather than only
          drawn. This is the whole content region, so a reader who was here when
          it resolved is told it did. */}
      <div aria-live="polite" aria-busy={status === 'loading'}>
        {status === 'loading' && <LoadingSkeleton heights={[96, 220, 200]} />}

        {status === 'error' && (
          <div className="alert alert-danger" role="alert">
            These figures could not be loaded. They are computed live from attendance
            records, so this is a problem reaching the server rather than missing data.
          </div>
        )}

        {status === 'ready' && (
          <div className="stack-lg">
            <section aria-labelledby="impact-totals">
              <h2 className="sr-only" id="impact-totals">Totals</h2>
              <div className="impact-figures">
                <Figure icon={Users} value={nf.format(data.community.totalVolunteers)}
                  label="Volunteers" note={d.totalVolunteers} />
                <Figure icon={Clock} value={nf.format(Math.round(data.community.totalHours))}
                  label="Hours served" note={d.totalHours} />
                <Figure icon={CalendarCheck} value={nf.format(data.community.eventsCompleted)}
                  label="Events completed" note={d.eventsCompleted} />
                <Figure icon={Building2} value={nf.format(data.community.organizationsSupported)}
                  label="Organizations supported" note={d.organizationsSupported} />
              </div>
            </section>

            <section className="card card-pad" aria-labelledby="impact-trend">
              <h2 id="impact-trend">Hours credited, by month</h2>
              {publishedMonths.length === 0 ? (
                <EmptyState
                  title="No confirmed hours yet"
                  message="A month appears here once an organizer has confirmed that somebody was present."
                />
              ) : (
                <>
                  <HoursByMonth months={publishedMonths} />
                  {/* The table view. Not hidden — a reader who wants the numbers
                      should not have to find a screen-reader-only element, and a
                      chart's exact values are the thing most often wanted. */}
                  <details className="chart-table">
                    <summary>View as a table</summary>
                    <table className="table">
                      <caption className="sr-only">Hours credited, volunteers and events by month</caption>
                      <thead>
                        <tr><th scope="col">Month</th><th scope="col">Hours</th><th scope="col">Volunteers</th><th scope="col">Events</th></tr>
                      </thead>
                      <tbody>
                        {publishedMonths.map(m => (
                          <tr key={m.month}>
                            <th scope="row">{monthLabel(m.month)}</th>
                            <td>{formatHours(m.hours)}</td>
                            <td>{m.suppressed ? <span className="dim">withheld</span> : nf.format(m.count)}</td>
                            <td>{nf.format(m.events ?? 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                  {suppressedMonths > 0 && (
                    <p className="small dim">
                      {suppressedMonths === 1 ? 'One month has' : `${suppressedMonths} months have`} a
                      volunteer count withheld: fewer than {data.minBucket} people took part, which is
                      few enough that the figure describes individuals. The hours are still counted.
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="card card-pad" aria-labelledby="impact-categories">
              <h2 id="impact-categories">Where the effort went</h2>
              {!hasCategoryHours ? (
                <EmptyState
                  title="No categorised hours yet"
                  message="Categories appear once events with confirmed attendance have been categorised."
                />
              ) : (
                <>
                  <HoursByCategory categories={categories} />
                  {suppressedCategories > 0 && (
                    <p className="small dim">
                      {suppressedCategories === 1 ? 'One category is' : `${suppressedCategories} categories are`} shown
                      by hours only. Fewer than {data.minBucket} volunteers took part in each, so the
                      count of people is withheld.
                    </p>
                  )}
                </>
              )}
            </section>

            {/**
              * What organizers said their events were about.
              *
              * Rendered only when tags exist: a district that has not started
              * tagging should not be shown an empty section implying it is missing
              * something. Beside the category breakdown rather than instead of it —
              * tags are optional, so a tag-only view would silently omit every
              * untagged event, while `category` is CHECK-constrained and always
              * present.
              */}
            {tagBreakdown.length > 0 && (
              <section className="card card-pad" aria-labelledby="impact-tags">
                <h2 id="impact-tags">What organizers tagged</h2>
                {/* Said BEFORE the bars, not after. An event's hours count under
                    every tag it carries, so this column sums to more than the
                    platform total — a reader who adds it up after the fact has
                    already been misled. The server declares the overlap rather
                    than this screen assuming it. */}
                {data.tags.overlapping && (
                  <p className="small dim">
                    An event counts under each of its tags, so these hours overlap and
                    add up to more than the total above.
                  </p>
                )}
                <HoursByCategory categories={tagBreakdown} />
                {suppressedTags > 0 && (
                  <p className="small dim">
                    {suppressedTags === 1 ? 'One tag is' : `${suppressedTags} tags are`} shown by
                    hours only. Fewer than {data.minBucket} volunteers took part under each — and a
                    tag an organizer typed can be far more specific than a category, so the count of
                    people is withheld.
                  </p>
                )}
              </section>
            )}

            <section className="card card-pad" aria-labelledby="impact-participation">
              <h2 id="impact-participation">How people took part</h2>
              <div className="impact-figures">
                {data.volunteers.returningRate !== null && (
                  <Figure icon={Repeat} value={`${data.volunteers.returningRate}%`}
                    label="Came back for more" note={d.returningRate} />
                )}
                {data.volunteers.averageHours !== null && (
                  <Figure icon={Clock} value={formatHours(data.volunteers.averageHours)}
                    label="Average hours each" note={d.averageHours} />
                )}
                {data.volunteers.medianHours !== null && (
                  <Figure icon={Clock} value={formatHours(data.volunteers.medianHours)}
                    label="Median hours each" note={d.medianHours} />
                )}
                <Figure icon={MapPin} value={nf.format(data.geography.distinctLocations)}
                  label="Places served" note={d.distinctLocations} />
              </div>
            </section>

            <section className="card card-pad stack-sm" aria-labelledby="impact-method">
              <h2 id="impact-method">How these are counted</h2>
              <p className="small dim">
                Hours are credited only after an organizer confirms that somebody was present,
                and a credited hour is never re-priced afterwards. A volunteer is counted once
                however many shifts they work. "Came back for more" counts a second, different
                event — two shifts at one event is one commitment.
              </p>
              <p className="small dim">
                Any breakdown covering fewer than {data.minBucket} volunteers has its count
                withheld rather than dropped, so a gap here means "too few to describe safely",
                never "none". Platform-wide totals are never suppressed.
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
