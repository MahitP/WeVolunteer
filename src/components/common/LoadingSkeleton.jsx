import React from 'react';

export default function LoadingSkeleton({ 
  heights = [120, 200], 
  className = "stack-lg page",
  style = { padding: 'var(--s6)' }
}) {
  return (
    <div className={className} style={style}>
      {heights.map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h }} />
      ))}
    </div>
  );
}
