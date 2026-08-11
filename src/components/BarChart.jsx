import React from 'react';

/**
 * Dependency-free SVG charts.
 *
 * These read hours, so they lead with the accent (hours) colour — colour
 * means the same thing here as everywhere else in the product. The palette
 * is a small set of distinguishable hues rather than a rainbow ramp.
 */
const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
/**
 * `caption` and `unit` say what the chart is ACTUALLY of.
 *
 * They exist because the accessible table's caption was hardcoded to "Hours by
 * period" and its value column to "Hours" — so AdminDashboard's
 * volunteers-per-month chart announced itself to a screen reader as hours, and
 * so did any future chart of anything else. The visual half is
 * `aria-hidden`, so that caption is the ONLY description a screen-reader user
 * gets: wrong there means wrong everywhere for them.
 *
 * `emptyText` for the same reason — "No hours recorded yet" is a lie on a chart
 * of sign-ups. Defaults preserve the existing hours-shaped behaviour, so every
 * current caller keeps its wording without being touched.
 */
export function BarChart({
  data = [],
  valueKey = 'value',
  labelKey = 'label',
  height = 120,
  highlightLast = false,
  caption = 'Hours by period',
  unit = 'Hours',
  periodLabel = 'Period',
  emptyText = 'No hours recorded yet',
  highlightNote = 'current'
}) {
  if (!data || data.length === 0) {
    return <p className="small dim s-739dac">{emptyText}</p>;
  }
  const max = Math.max(1, ...data.map(d => Number(d[valueKey]) || 0));
  return <div role="img" aria-label={caption}>
      {/* The bars are shape only — the numeric labels beneath them are laid out
          in a separate grid, so a screen reader reads a column of values with
          no way to tell which label belongs to which. This table carries the
          same data in a structure that pairs them, and is hidden visually so
          the chart itself is unchanged. aria-hidden on the visual half stops
          the figures being announced twice. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr><th scope="col">{periodLabel}</th><th scope="col">{unit}</th></tr>
        </thead>
        <tbody>
          {data.map((d, i) => <tr key={i}>
              {/* The highlighted column is distinguished ONLY by colour in the
                  visual half, and the table below is what a screen reader
                  actually reads — so without this the distinction does not
                  exist for that reader at all. */}
              <th scope="row">
                {longLabel(d[labelKey])}
                {highlightLast && i === data.length - 1 ? ` (${highlightNote})` : ''}
              </th>
              <td>{fmt(d[valueKey])}</td>
            </tr>)}
        </tbody>
      </table>

      {/* `--bars` rather than an inline `gridTemplateColumns`.

          index.css records a real "the dashboard is zoomed out on my phone"
          bug caused by exactly that: an inline grid declaration is more
          specific than any media query, so the layout could not be adjusted for
          narrow screens at all. With the series zero-filled to a fixed six
          columns, the tightest case (about 36px per bar at 320px) is now the
          ALWAYS case rather than an occasional one — so being able to reach the
          value row from a media query is the difference between a readable
          chart and an overflowing one. */}
      <div aria-hidden="true" className="barchart-bars" style={{ '--bars': data.length, height }}>
        {data.map((d, i) => {
        const value = Number(d[valueKey]) || 0;
        const isLast = highlightLast && i === data.length - 1;
        return <div key={i} title={`${d[labelKey]}: ${value}`} style={{
          height: `${Math.max(2, value / max * 100)}%`,
          background: isLast ? 'var(--accent)' : 'var(--brand-tint-2)',
          borderRadius: '3px 3px 0 0',
          minHeight: 2,
          // A single month shouldn't render as a full-width slab
          maxWidth: 72,
          width: '100%',
          justifySelf: 'center'
        }} />;
      })}
      </div>

      <div aria-hidden="true" className="barchart-labels" style={{ '--bars': data.length }}>
        {data.map((d, i) => <div key={i} className="s-052d03">
            <div className="tnum barchart-value">{fmt(d[valueKey])}</div>
            <div className="truncate s-3581ab">
              {shortLabel(d[labelKey])}
            </div>
          </div>)}
      </div>
    </div>;
}
export function Sparkline({
  values = [],
  height = 34
}) {
  if (!values || values.length === 0) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const stepX = 100 / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${i * stepX},${height - (v - min) / range * (height - 4) - 2}`).join(' ');
  return <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{
    width: '100%',
    height
  }} aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--brand)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>;
}
function fmt(n) {
  const value = Number(n) || 0;
  return value % 1 === 0 ? String(value) : value.toFixed(1);
}

/** "2026-07" → "Jul". Anything else passes through unchanged. */
function shortLabel(label) {
  if (typeof label === 'string' && /^\d{4}-\d{2}$/.test(label)) {
    const [y, m] = label.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, {
      month: 'short'
    });
  }
  return label;
}

/**
 * Full label for the accessible table.
 *
 * The visual axis can say "Jul" because the surrounding chart supplies the
 * context. Read aloud in isolation, "Jul" — or worse, the raw "2026-07" —
 * tells the listener nothing about which July.
 */
function longLabel(label) {
  if (typeof label === 'string' && /^\d{4}-\d{2}$/.test(label)) {
    const [y, m] = label.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric'
    });
  }
  return label;
}