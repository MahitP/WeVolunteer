import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { Search, User, X } from 'lucide-react';

export default function RecipientPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.searchMessagesUsers(query);
        setResults(data.users || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }, 300);
    
    return () => clearTimeout(timeout);
  }, [query]);

  return (
    <div className="modal-overlay" onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'var(--backdrop)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{
        width: '90%', maxWidth: '500px', maxHeight: '80vh', display: 'flex', flexDirection: 'column'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>New Message</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        
        <div style={{ position: 'relative', marginBottom: '1rem' }}>
          <Search size={18} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-muted)' }} />
          <input
            type="text"
            className="input"
            style={{ width: '100%', paddingLeft: '36px' }}
            placeholder="Search for a volunteer or organizer..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        
        <div style={{ overflowY: 'auto', flex: 1, borderTop: '1px solid var(--border)' }}>
          {loading && <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>Searching...</div>}
          {!loading && query.length >= 2 && results.length === 0 && (
             <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>No users found for "{query}"</div>
          )}
          {!loading && results.map(u => (
            <div 
              key={`${u.id}-${u.eventId}`} 
              onClick={() => onSelect(u)}
              style={{
                display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem',
                borderBottom: '1px solid var(--border)', cursor: 'pointer'
              }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--surface-hover)'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <div style={{
                width: '40px', height: '40px', borderRadius: '50%', backgroundColor: 'var(--bg-secondary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem'
              }}>
                 {u.avatar ? u.avatar : <User size={20} />}
              </div>
              <div>
                 <div style={{ fontWeight: 600 }}>{u.name} <span style={{ fontWeight: 'normal', color: 'var(--text-muted)' }}>@{u.username}</span></div>
                 <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{u.eventTitle}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
