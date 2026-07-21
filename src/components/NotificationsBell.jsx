import React, { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ArrowRight } from 'lucide-react';
import { api } from '../utils/api';
import { timeAgo } from '../utils/helpers';
import { notificationMeta } from '../utils/notifications';

/**
 * Quick-glance notifications. Answers "anything new?" in one click; anything
 * more than that is the notification centre's job.
 */
export default function NotificationsBell({ onViewEvent, onSeeAll, refreshKey }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ notifications: [], unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const containerRef = useRef(null);

  const load = async () => {
    try {
      setData(await api.fetchNotifications(12));
    } catch (e) {
      console.error('Failed to load notifications:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markAllRead = async () => {
    setData(d => ({ ...d, unreadCount: 0, notifications: d.notifications.map(n => ({ ...n, read: true })) }));
    try { await api.markNotificationsRead({ all: true }); } finally { load(); }
  };

  const markRead = async (id) => {
    setData(d => ({
      ...d,
      unreadCount: Math.max(0, d.unreadCount - 1),
      notifications: d.notifications.map(n => (n.id === id ? { ...n, read: true } : n))
    }));
    try { await api.markNotificationsRead({ ids: [id] }); } finally { load(); }
  };

  const handleClick = (n) => {
    if (!n.read) markRead(n.id);
    setOpen(false);
    if (n.link?.startsWith('event:')) onViewEvent?.(n.link.split(':')[1]);
  };

  const unread = data.unreadCount || 0;
  const items = data.notifications || [];

  return (
    <div ref={containerRef} className="bell">
      <button
        className="btn btn-secondary btn-icon"
        onClick={() => setOpen(o => !o)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell size={16} />
        {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div
          className="popover"
          role="dialog"
          aria-label="Notifications"
          style={{ top: 'calc(100% + 8px)', right: 0, width: 'min(380px, calc(100vw - 2rem))' }}
        >
          <div className="popover-head">
            <span className="popover-title">
              Notifications{unread > 0 && <span className="dim"> · {unread} new</span>}
            </span>
            {unread > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={markAllRead} style={{ marginLeft: 'auto' }}>
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>

          <div className="popover-scroll">
            {loading && items.length === 0 ? (
              <div style={{ padding: 'var(--s4)' }} className="stack-sm">
                {[0, 1, 2].map(i => <div key={i} className="skeleton skeleton-row" />)}
              </div>
            ) : items.length === 0 ? (
              <div className="empty" style={{ padding: 'var(--s8) var(--s5)' }}>
                <span className="empty-icon"><Bell size={18} /></span>
                <h3>You're all caught up</h3>
                <p>Replies to your applications and event updates show up here.</p>
              </div>
            ) : (
              items.map(n => {
                const meta = notificationMeta(n.kind);
                const Icon = meta.icon;
                return (
                  <button
                    key={n.id}
                    className={`notif ${n.read ? '' : 'unread'}`}
                    onClick={() => handleClick(n)}
                  >
                    <span className={`notif-icon tone-${meta.tone}`}><Icon size={14} /></span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="notif-title" style={{ display: 'block' }}>{n.title}</span>
                      <span className="notif-body" style={{ display: 'block' }}>{n.body}</span>
                      <span className="notif-time" style={{ display: 'block' }}>{timeAgo(n.createdAt)}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {onSeeAll && (
            <button
              className="popover-foot"
              onClick={() => { setOpen(false); onSeeAll(); }}
            >
              See all notifications <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
