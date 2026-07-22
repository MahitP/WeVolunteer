import React from 'react';

export default function LoadingSkeleton({ 
  heights = [120, 200], 
  style = {} 
}) {
  return (
    <div className="stack-lg page" style={{ padding: 'var(--s6)', ...style }}>
      {heights.map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h }} />
      ))}
    </div>
  );
}
