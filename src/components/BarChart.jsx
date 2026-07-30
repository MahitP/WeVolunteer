import React from 'react';

/**
 * Dependency-free SVG charts.
 *
 * These read hours, so they lead with the accent (hours) colour — colour
 * means the same thing here as everywhere else in the product. The palette
 * is a small set of distinguishable hues rather than a rainbow ramp.
 */
const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
export function BarChart({
  data = [],
  valueKey = 'value',
  labelKey = 'label',
  height = 120,
  highlightLast = false
}) {
  if (!data || data.length === 0) {
    return <p className="small dim s-739dac">No hours recorded yet</p>;
  }
  const max = Math.max(1, ...data.map(d => Number(d[valueKey]) || 0));
  return <div>
      {/* The bars are shape only — the numeric labels beneath them are laid out
          in a separate grid, so a screen reader reads a column of values with
          no way to tell which label belongs to which. This table carries the
          same data in a structure that pairs them, and is hidden visually so
          the chart itself is unchanged. aria-hidden on the visual half stops
          the figures being announced twice. */}
      <table className="sr-only">
        <caption>Hours by period</caption>
        <thead>
          <tr><th scope="col">Period</th><th scope="col">Hours</th></tr>
        </thead>
        <tbody>
          {data.map((d, i) => <tr key={i}>
              <th scope="row">{longLabel(d[labelKey])}</th>
              <td>{fmt(d[valueKey])}</td>
            </tr>)}
        </tbody>
      </table>

      <div aria-hidden="true" style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${data.length}, 1fr)`,
      alignItems: 'end',
      gap: 6,
      height
    }}>
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

      <div aria-hidden="true" style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${data.length}, 1fr)`,
      gap: 6,
      marginTop: 6,
      borderTop: '1px solid var(--rule)',
      paddingTop: 6
    }}>
        {data.map((d, i) => <div key={i} className="s-052d03">
            <div className="tnum s-edb0fa">{fmt(d[valueKey])}</div>
            <div className="truncate s-3581ab">
              {shortLabel(d[labelKey])}
            </div>
          </div>)}
      </div>
    </div>;
}
export function DonutChart({
  data = [],
  valueKey = 'value',
  labelKey = 'label',
  size = 116,
  thickness = 16
}) {
  const total = data.reduce((sum, d) => sum + (Number(d[valueKey]) || 0), 0);
  if (total === 0) {
    return <p className="small dim s-739dac">No hours recorded yet</p>;
  }
  const radius = (size - thickness) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;

  // Cumulative offsets derived in one pass — no mutation during render.
  const segments = data.reduce((acc, d, i) => {
    const value = Number(d[valueKey]) || 0;
    const length = value / total * circumference;
    const prev = acc[acc.length - 1];
    acc.push({
      key: i,
      length,
      offset: prev ? prev.offset + prev.length : 0,
      color: PALETTE[i % PALETTE.length],
      label: d[labelKey],
      value
    });
    return acc;
  }, []);
  return <div className="row s-473ea3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${fmt(total)} hours total across ${data.length} categories`} className="s-c99770">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
        {segments.map(seg => <circle key={seg.key} cx={center} cy={center} r={radius} fill="none" stroke={seg.color} strokeWidth={thickness} strokeDasharray={`${seg.length} ${circumference - seg.length}`} strokeDashoffset={-seg.offset} transform={`rotate(-90 ${center} ${center})`} />)}
        <text x={center} y={center - 2} textAnchor="middle" fontSize="17" fontWeight="700" fill="var(--ink)" fontFamily="var(--font-display)">
          {fmt(total)}
        </text>
        <text x={center} y={center + 13} textAnchor="middle" fontSize="9" fill="var(--ink-3)">hours</text>
      </svg>

      <div className="stack-sm s-7b2db8">
        {segments.map(seg => <div key={seg.key} className="row small s-65ce96">
            <span style={{
          width: 9,
          height: 9,
          borderRadius: 2,
          background: seg.color,
          flexShrink: 0
        }} />
            <span className="truncate muted s-49cdf8">{seg.label}</span>
            <span className="strong tnum">{fmt(seg.value)}</span>
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