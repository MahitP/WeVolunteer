import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';

export default function BadgesList({ userId }) {
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const res = await api.apiFetch(`/api/users/${userId}/badges`);
        setBadges(res.badges || []);
      } catch (err) {
        setError('Failed to load badges.');
      } finally {
        setLoading(false);
      }
    };
    if (userId) fetchBadges();
  }, [userId]);

  if (loading) return <div className="card loading-skeleton" style={{ height: 120 }}></div>;
  if (error) return <div className="card text-danger">{error}</div>;

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Achievements</h3>
      </div>
      <div className="card-body">
        {badges.length === 0 ? (
          <p className="text-secondary">No badges earned yet. Participate in events to earn them!</p>
        ) : (
          <div className="row row-wrap" style={{ gap: '1rem' }}>
            {badges.map(b => (
              <div key={b.id} className="badge-item" style={{ textAlign: 'center', maxWidth: 100 }}>
                <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>{b.icon}</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{b.name}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--ink-3)' }}>
                  {new Date(b.earned_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
