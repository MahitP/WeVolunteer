import React from 'react';
import { ArrowLeft } from 'lucide-react';

export default function SettingsSection({ title, children, onBack, isMobile }) {
  return (
    <section className="settings-section fade-in">
      <div className="section-head" style={{ marginBottom: isMobile ? 'var(--s4)' : 'var(--s6)' }}>
        {isMobile && (
          <button 
            className="btn btn-ghost btn-icon section-action" 
            onClick={onBack}
            aria-label="Back to settings menu"
            style={{ marginRight: 'var(--s2)' }}
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <h2 style={{ fontSize: isMobile ? '1.125rem' : '1.5rem' }}>{title}</h2>
      </div>
      <div className="settings-section-content stack-lg">
        {children}
      </div>
    </section>
  );
}
