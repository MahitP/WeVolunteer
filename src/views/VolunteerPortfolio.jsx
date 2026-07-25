import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { formatHours, formatDay } from '../utils/helpers';
import { ArrowLeft, Printer, ShieldCheck, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { APP_NAME, SCHOOL_NAME } from '../config';

export default function VolunteerPortfolio({ currentUser }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    if (!currentUser) return;

    setLoading(true);
    api.fetchVolunteerProfile(currentUser.id)
      .then(res => {
        if (!cancelled) setData(res);
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [currentUser]);

  if (loading) {
    return (
      <div className="stack-lg page" style={{ padding: 'var(--s6)' }}>
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 400 }} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card empty" style={{ margin: 'var(--s6)' }}>
        <h3>Portfolio unavailable</h3>
        <p>{error || 'Could not load your service record.'}</p>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate(-1)}>Go back</button>
      </div>
    );
  }

  const { volunteer, stats, completed } = data;

  return (
    <div style={{ backgroundColor: 'var(--paper)', minHeight: '100vh', paddingBottom: 'var(--s8)' }}>
      {/* ── Screen-only controls ── */}
      <div className="no-print" style={{ backgroundColor: 'var(--surface-2)', borderBottom: '1px solid var(--rule)', padding: 'var(--s4) var(--s6)' }}>
        <div className="row-between mx-auto" style={{ maxWidth: 800 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} /> Back to profile
          </button>
          <button className="btn btn-primary" onClick={() => window.print()}>
            <Printer size={16} /> Print or save PDF
          </button>
        </div>
      </div>

      {/* ── Printable Area ── */}
      <div className="mx-auto" style={{ maxWidth: 800, padding: 'var(--s8) var(--s6)', backgroundColor: '#fff', color: '#000', minHeight: '100vh' }}>
        
        {/* Header */}
        <header style={{ borderBottom: '2px solid #000', paddingBottom: 'var(--s5)', marginBottom: 'var(--s6)' }}>
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <div>
              <h1 style={{ fontSize: '2rem', margin: 0, color: '#000' }}>{volunteer.name}</h1>
              <p style={{ fontSize: '1.1rem', color: '#444', marginTop: 4 }}>Official Record of Volunteer Service</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 600, fontSize: '1.2rem' }}>{APP_NAME}</div>
              <div style={{ color: '#444' }}>{SCHOOL_NAME}</div>
              <div style={{ color: '#444', marginTop: 8 }}>Generated: {formatDay(new Date().toISOString())}</div>
            </div>
          </div>
        </header>

        {/* Summary */}
        <section style={{ marginBottom: 'var(--s8)' }}>
          <div style={{ display: 'flex', gap: 'var(--s6)' }}>
            <div>
              <div style={{ fontSize: '0.9rem', color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Total Verified Hours</div>
              <div style={{ fontSize: '2.5rem', fontWeight: 700, color: '#000' }}>{formatHours(stats.hours)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.9rem', color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Events Completed</div>
              <div style={{ fontSize: '2.5rem', fontWeight: 700, color: '#000' }}>{stats.eventsCompleted}</div>
            </div>
          </div>
        </section>

        {/* Ledger */}
        <section>
          <h2 style={{ fontSize: '1.4rem', borderBottom: '1px solid #ccc', paddingBottom: 'var(--s2)', marginBottom: 'var(--s4)', color: '#000' }}>
            Service Ledger
          </h2>
          
          {completed.length === 0 ? (
            <p style={{ color: '#666' }}>No completed service hours on record.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #000', textAlign: 'left' }}>
                  <th style={{ padding: 'var(--s2) 0', color: '#444' }}>Date</th>
                  <th style={{ padding: 'var(--s2) var(--s4)', color: '#444' }}>Event & Organization</th>
                  <th style={{ padding: 'var(--s2) 0', color: '#444', textAlign: 'right' }}>Hours</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((c, idx) => (
                  <tr key={`${c.eventId}-${idx}`} style={{ borderBottom: '1px solid #eaeaea', pageBreakInside: 'avoid' }}>
                    <td style={{ padding: 'var(--s3) 0', verticalAlign: 'top', width: '20%' }}>
                      {formatDay(c.startDatetime)}
                    </td>
                    <td style={{ padding: 'var(--s3) var(--s4)', verticalAlign: 'top' }}>
                      <div style={{ fontWeight: 600, color: '#000' }}>{c.title}</div>
                      <div style={{ color: '#444', marginTop: 2 }}>{c.organizerName}</div>
                      <div style={{ color: '#666', fontSize: '0.85rem', marginTop: 4 }}>{c.slotName}</div>
                    </td>
                    <td style={{ padding: 'var(--s3) 0', verticalAlign: 'top', textAlign: 'right', fontWeight: 600, width: '15%' }}>
                      {formatHours(c.hours)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Official Note & Signature */}
        <div style={{ marginTop: 'var(--s8)', paddingTop: 'var(--s6)', borderTop: '1px solid #ccc', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ color: '#666', fontSize: '0.9rem', maxWidth: '60%' }}>
            This document serves as the official record of volunteer service for {volunteer.name}. 
            All hours listed have been verified by event organizers on the {APP_NAME} platform.
          </div>
          <div style={{ width: 250, textAlign: 'center' }}>
            <div style={{ borderBottom: '1px solid #000', marginBottom: 8, height: 40 }}></div>
            <div style={{ fontSize: '0.9rem', color: '#444' }}>Authorized Signature</div>
          </div>
        </div>

      </div>
    </div>
  );
}
