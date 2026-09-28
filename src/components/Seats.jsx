import React from 'react';
import TintOnChange from './common/TintOnChange';

/**
 * Capacity, shown one way across the whole product.
 *
 * Small capacities render as discrete seats (▪▪▪▫▫) because volunteers think
 * in individual spots — "two left" is the decision they're making. Above a
 * dozen the squares stop being countable, so we fall back to a meter, which
 * keeps the same colour language.
 */
export function Seats({
  filled = 0,
  total = 0,
  mine = 0,
  showLabel = true,
  className = ''
}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeFilled = Math.min(safeTotal, Math.max(0, Number(filled) || 0));
  const remaining = safeTotal - safeFilled;
  const isFull = remaining <= 0 && safeTotal > 0;
  const label = safeTotal === 0 ? 'No spots' : isFull ? 'Full' : `${remaining} of ${safeTotal} spots left`;
  if (safeTotal > 12) {
    const pct = safeTotal ? safeFilled / safeTotal * 100 : 0;
    return <div className={`seats-meter ${className}`}>
        <div className="meter-label">
          <span>{safeFilled} signed up</span>
          {/* The two halves sit at opposite ends of the meter, so no visible
              separator belongs between them. But they are adjacent in the text
              layer, where `textContent` concatenates to "0 signed up15 of 15
              spots left" — which is what a screen reader and any copied text
              get. This separator is the text-layer equivalent of the visual gap,
              and it means the reading is correct even where CSS does not apply. */}
          <span className="sr-only"> · </span>
          <TintOnChange value={label} className={isFull ? 'strong' : ''}>{label}</TintOnChange>
        </div>
        <div className="meter">
          <div className={`meter-fill ${isFull ? 'full' : ''}`} style={{
          width: `${pct}%`
        }} />
        </div>
      </div>;
  }
  return <div className={`row seats-row ${className}`}>
      <span className="seats" role="img" aria-label={`${safeFilled} of ${safeTotal} spots taken`}>
        {Array.from({
        length: safeTotal
      }, (_, i) => {
        const isMine = i >= safeFilled - mine && i < safeFilled;
        return <span key={i} className={`seat ${i < safeFilled ? isMine ? 'mine' : '' : 'open'}`} />;
      })}
      </span>
      {showLabel && <TintOnChange value={label} className={`seats-label ${isFull ? 'full' : ''}`}>{label}</TintOnChange>}
    </div>;
}

/** A calendar tear-off. Used anywhere an event or shift has a date. */
export function DateChip({
  iso,
  className = ''
}) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const past = d < new Date();
  return <div className={`datechip ${past ? 'past' : ''} ${className}`}>
      <div className="datechip-m">{d.toLocaleDateString(undefined, {
        month: 'short'
      })}</div>
      <div className="datechip-d">{d.getDate()}</div>
    </div>;
}