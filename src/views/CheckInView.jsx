import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';
import { formatTimeRange } from '../utils/helpers';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';

/**
 * Mobile-first day-of check-in view for organizers.
 * This does not finalize hours — it only records check-in status (present=null) 
 * so the organizer can see who showed up. Hours are finalized later via EventModal.
 */
export default function CheckInView({ _currentUser }) {
  const { eventId } = useParams();
  const navigate = useNavigate();

  const [event, setEvent] = useState(null);
  const [applications, setApplications] = useState([]);
  const [checkins, setCheckins] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Mobile check-in organizes by shift if there are multiple, or shows a flat list if there's only one.
  const [selectedSlotId, setSelectedSlotId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.fetchEventDetails(eventId),
      api.fetchCheckins(eventId).catch(() => []) // Check-ins might return 404 if none exist, handle safely
    ])
    .then(([details, checkinData]) => {
      if (cancelled) return;
      setEvent(details.event);
      setApplications(details.applications.filter(a => a.status === 'accepted'));
      
      const checkMap = new Map(checkinData.map(c => [`${c.slotId}:${c.userId}`, c.present]));
      setCheckins(checkMap);
      
      if (details.event.slots && details.event.slots.length > 0) {
        setSelectedSlotId(details.event.slots[0].id);
      }
    })
    .catch(err => {
      if (!cancelled) setError(err.message);
    })
    .finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [eventId]);

  const toggleCheckin = async (app) => {
    const key = `${app.slotId}:${app.userId}`;
    const currentlyPresent = !!checkins.get(key);
    const newPresent = !currentlyPresent;

    // Optimistic update
    setCheckins(prev => new Map(prev).set(key, newPresent));

    try {
      // The server keys check-in marks by application id, not slot:user.
      const res = await api.submitCheckins(eventId, { [app.id]: newPresent });
      if (res.marked !== 1) {
        throw new Error('The server did not record that mark.');
      }
    } catch (err) {
      setCheckins(prev => new Map(prev).set(key, currentlyPresent));
      alert(`Could not save check-in: ${err.message}`);
    }
  };

  const markAll = async (slotId, present) => {
    const appsInSlot = applications.filter(a => a.slotId === slotId);
    const updates = {};
    const optimisticMap = new Map(checkins);

    appsInSlot.forEach(app => {
      updates[app.id] = present;
      optimisticMap.set(`${app.slotId}:${app.userId}`, present);
    });

    const previous = new Map(checkins);
    setCheckins(optimisticMap);
    try {
      const res = await api.submitCheckins(eventId, updates);
      if (res.marked !== appsInSlot.length) {
        throw new Error(`Only ${res.marked} of ${appsInSlot.length} marks were recorded.`);
      }
    } catch (err) {
      setCheckins(previous);
      alert(`Could not save check-ins: ${err.message}`);
    }
  };

  if (loading) {
    return <LoadingSkeleton heights={[60, 400]} className="stack-lg page" style={{ padding: 'var(--s4)' }} />;
  }

  if (error || !event) {
    return (
      <EmptyState 
        icon={AlertTriangle} 
        title="Cannot load check-in" 
        message={error || 'Event not found.'} 
        style={{ margin: 'var(--s6)' }} 
      />
    );
  }

  const hasMultipleSlots = event.slots.length > 1;
  const currentSlot = event.slots.find(s => s.id === selectedSlotId) || event.slots[0];
  const appsForCurrentSlot = applications.filter(a => a.slotId === currentSlot?.id);
  const presentCount = appsForCurrentSlot.filter(a => checkins.get(`${a.slotId}:${a.userId}`)).length;

  return (
    <div style={{ backgroundColor: 'var(--paper)', minHeight: '100vh', paddingBottom: 'var(--s8)' }}>
      {/* ── Top Bar ── */}
      <div style={{ backgroundColor: 'var(--surface-2)', borderBottom: '1px solid var(--rule)', padding: 'var(--s3) var(--s4)', position: 'sticky', top: 0, zIndex: 10 }}>
        <div className="row-between mx-auto" style={{ maxWidth: 600 }}>
          <button className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }} onClick={() => navigate(-1)} aria-label="Go back">
            <ArrowLeft size={20} /> <span style={{ marginLeft: 4 }}>Back</span>
          </button>
          <div style={{ fontWeight: 600, fontSize: '1rem' }} className="truncate">{event.title}</div>
          <div style={{ width: 40 }} /> {/* Spacer for balance */}
        </div>
      </div>

      <div className="mx-auto" style={{ maxWidth: 600, padding: 'var(--s4)' }}>
        <div className="alert alert-info" style={{ marginBottom: 'var(--s4)' }}>
          <strong>Check-in doesn't finalize hours.</strong> Use this during the event to track who showed up. Finalize hours later on a computer.
        </div>

        {hasMultipleSlots && (
          <div style={{ display: 'flex', overflowX: 'auto', gap: 'var(--s2)', paddingBottom: 'var(--s2)', marginBottom: 'var(--s2)', WebkitOverflowScrolling: 'touch' }}>
            {event.slots.map(slot => (
              <button 
                key={slot.id} 
                className={`btn btn-sm ${selectedSlotId === slot.id ? 'btn-primary' : 'btn-secondary'}`}
                style={{ flexShrink: 0 }}
                onClick={() => setSelectedSlotId(slot.id)}
              >
                {slot.name}
              </button>
            ))}
          </div>
        )}

        <div className="row-between" style={{ marginBottom: 'var(--s4)' }}>
          <h2 style={{ fontSize: '1.2rem', margin: 0 }}>
            {currentSlot ? formatTimeRange(currentSlot.startDatetime, currentSlot.endDatetime) : 'All Volunteers'}
          </h2>
          {appsForCurrentSlot.length > 0 && (
            <span className="small muted">
              <span className="strong tnum" style={{ color: 'var(--ink)' }}>{presentCount}</span> / {appsForCurrentSlot.length} here
            </span>
          )}
        </div>

        {appsForCurrentSlot.length === 0 ? (
          <EmptyState 
            icon={Users} 
            title="No volunteers here" 
            message="Nobody is scheduled for this shift." 
            style={{ padding: 'var(--s6) var(--s4)' }} 
          />
        ) : (
          <div className="stack-sm">
            <div className="row row-wrap" style={{ gap: 'var(--s2)', marginBottom: 'var(--s2)' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => markAll(currentSlot.id, true)}>
                Mark all here
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => markAll(currentSlot.id, false)}>
                Mark all missing
              </button>
            </div>
            
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {appsForCurrentSlot.map((app, i) => {
                const isPresent = !!checkins.get(`${app.slotId}:${app.userId}`);
                return (
                  <label 
                    key={app.id} 
                    className="row"
                    style={{ 
                      padding: 'var(--s3) var(--s4)',
                      borderBottom: i < appsForCurrentSlot.length - 1 ? '1px solid var(--rule)' : 'none',
                      backgroundColor: isPresent ? 'var(--brand-tint)' : 'transparent',
                      cursor: 'pointer',
                      transition: 'background-color 0.15s ease'
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 'var(--s3)' }}>
                        <span className="avatar sm">{app.volunteer?.avatar || '👤'}</span>
                        <div className="truncate">
                          <div style={{ fontWeight: 500, fontSize: '1.05rem', color: isPresent ? 'var(--brand-ink)' : 'var(--ink)' }} className="truncate">
                            {app.volunteer?.name}
                          </div>
                          {app.volunteer?.grade && (
                            <div className="small muted truncate" style={{ marginTop: 2 }}>
                              Grade {app.volunteer.grade}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <input 
                        type="checkbox" 
                        checked={isPresent} 
                        onChange={() => toggleCheckin(app)}
                        style={{ width: 24, height: 24, margin: 0, accentColor: 'var(--brand)' }}
                      />
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
