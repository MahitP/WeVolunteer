import React, { useEffect, useState, useMemo } from 'react';
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import { api } from '../utils/api';
import { timeAgo, formatDay } from '../utils/helpers';
import { notificationMeta, NOTIFICATION_FILTERS, groupByDay } from '../utils/notifications';
import EmptyState from '../components/EmptyState';

/**
 * The full notification history. The bell answers "anything new?"; this page
 * answers "what happened, and what do I need to do about it?".
 */
export default function Notifications({ onViewEvent, onCountChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = async () => {
    try {
      const res = await api.fetchNotifications(200);
      setItems(res.notifications || []);
      onCountChange?.(res.unreadCount || 0);
    } catch (e) {
      console.error('Failed to load notifications:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const markRead = async (id) => {
    setItems(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
    try { await api.markNotificationsRead({ ids: [id] }); } finally { load(); }
  };

  const markAllRead = async () => {
    setItems(prev => prev.map(n => ({ ...n, read: true })));
    onCountChange?.(0);
    try { await api.markNotificationsRead({ all: true }); } finally { load(); }
  };

  const open = (n) => {
    if (!n.read) markRead(n.id);
    if (n.link?.startsWith('event:')) onViewEvent?.(n.link.split(':')[1]);
  };

  const activeKinds = NOTIFICATION_FILTERS.find(f => f.id === filter)?.kinds;
  const visible = useMemo(() => items.filter(n =>
    (!activeKinds || activeKinds.includes(n.kind)) && (!unreadOnly || !n.read)
  ), [items, activeKinds, unreadOnly]);

  const groups = useMemo(() => groupByDay(visible), [visible]);
  const unread = items.filter(n => !n.read).length;

  // Counts per filter so a student can see where the activity is
  const countFor = (f) => {
    const pool = f.kinds ? items.filter(n => f.kinds.includes(n.kind)) : items;
    return unreadOnly ? pool.filter(n => !n.read).length : pool.length;
  };

  if (loading) {
    return (
      <div className="stack">
        <div className="skeleton" style={{ height: 44 }} />
        {[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton skeleton-row" />)}
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <div className="chips">
          {NOTIFICATION_FILTERS.map(f => (
            <button
              key={f.id}
              className="chip"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {countFor(f) > 0 && <span className="dim"> {countFor(f)}</span>}
            </button>
          ))}
        </div>

        <label className="check" style={{ padding: '0.375rem 0.625rem', border: 'none', marginLeft: 'auto' }}>
          <input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} />
          <span className="small nowrap">Unread only</span>
        </label>

        {unread > 0 && (
          <button className="btn btn-secondary btn-sm" onClick={markAllRead}>
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Inbox size={18} />}
          title={unreadOnly ? 'Nothing unread' : filter === 'all' ? 'No notifications yet' : 'Nothing in this category'}
          message={
            unreadOnly
              ? "You've read everything here."
              : filter === 'all'
                ? 'When an organizer replies to an application or posts an update, it lands here.'
                : 'Try another category to see the rest of your activity.'
          }
          action={
            (unreadOnly || filter !== 'all') && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { setUnreadOnly(false); setFilter('all'); }}
              >
                Show everything
              </button>
            )
          }
        />
      ) : (
        groups.map(group => (
          <section key={group.label}>
            <div className="section-head">
              <h2>{group.label}</h2>
              <span className="section-action small dim">{group.items.length}</span>
            </div>
            <div className="list">
              {group.items.map(n => {
                const meta = notificationMeta(n.kind);
                const Icon = meta.icon;
                const clickable = !!n.link;
                return (
                  <div
                    key={n.id}
                    className={`list-row notif-row ${n.read ? '' : 'is-unread'}`}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => open(n) : undefined}
                    onKeyDown={clickable ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(n); }
                    } : undefined}
                    style={{ cursor: clickable ? 'pointer' : 'default' }}
                  >
                    <span className={`notif-icon tone-${meta.tone}`}>
                      <Icon size={15} />
                    </span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 'var(--s2)' }}>
                        <span className="person-name">{n.title}</span>
                        <span className={`tag tag-${meta.tone === 'muted' ? '' : meta.tone}`}>{meta.label}</span>
                        {!n.read && <span className="unread-dot" aria-label="Unread" />}
                      </div>
                      <p className="small muted" style={{ marginTop: 2 }}>{n.body}</p>
                      <p className="small dim tnum" style={{ marginTop: 4 }}>
                        {timeAgo(n.createdAt)} · {formatDay(n.createdAt)}
                      </p>
                    </div>

                    {!n.read && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={e => { e.stopPropagation(); markRead(n.id); }}
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {items.length > 0 && (
        <p className="small dim row" style={{ gap: 6, justifyContent: 'center' }}>
          <Bell size={12} /> Showing your {items.length} most recent notifications
        </p>
      )}
    </div>
  );
}
