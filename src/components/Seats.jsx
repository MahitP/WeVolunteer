import React from 'react';

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
  const label = safeTotal === 0 ? 'No spots' : isFull ? 'Full' : `${remaining} of ${safeTotal} left`;
  if (safeTotal > 12) {
    const pct = safeTotal ? safeFilled / safeTotal * 100 : 0;
    return <div className={`${className} s-95a51c`}>
        <div className="meter-label">
          <span>{safeFilled} signed up</span>
          <span className={isFull ? 'strong' : ''}>{label}</span>
        </div>
        <div className="meter">
          <div className={`meter-fill ${isFull ? 'full' : ''}`} style={{
          width: `${pct}%`
        }} />
        </div>
      </div>;
  }
  return <div className={`row ${className} s-65ce96`}>
      <span className="seats" role="img" aria-label={`${safeFilled} of ${safeTotal} spots taken`}>
        {Array.from({
        length: safeTotal
      }, (_, i) => {
        const isMine = i >= safeFilled - mine && i < safeFilled;
        return <span key={i} className={`seat ${i < safeFilled ? isMine ? 'mine' : '' : 'open'}`} />;
      })}
      </span>
      {showLabel && <span className={`seats-label ${isFull ? 'full' : ''}`}>{label}</span>}
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