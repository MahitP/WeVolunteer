import React from 'react';
import { Info } from 'lucide-react';

export default function EmptyState({ 
  icon: Icon = Info, 
  title, 
  message, 
  action = null,
  style = {} 
}) {
  return (
    <div className="card empty" style={style}>
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      {title && <h3>{title}</h3>}
      {message && <p>{message}</p>}
      {action && <div style={{ marginTop: 'var(--s4)' }}>{action}</div>}
    </div>
  );
}
