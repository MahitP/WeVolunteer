import React, { useEffect, useState, useMemo } from 'react';
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { timeAgo, formatDay } from '../utils/helpers';
import { notificationMeta, NOTIFICATION_FILTERS, groupByDay, groupNotifications } from '../utils/notifications';
import { subscribeSocket } from '../services/socket';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import { rowTransitionStyle, withViewTransition } from '../utils/motion';

/**
 * The full notification history. The bell answers "anything new?"; this page
 * answers "what happened, and what do I need to do about it?".
 */
export default function Notifications({ onViewEvent, onCountChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const navigate = useNavigate();

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

  useEffect(() => {
    const handleNewNotification = (payload) => {
      setItems(prev => {
        const existing = prev.find(n => n.id === payload.notification.id);
        if (existing) return prev;
        const updated = [payload.notification, ...prev];
        onCountChange?.(updated.filter(n => !n.read).length);
        return updated;
      });
    };
    
    const handleReadNotification = (payload) => {
      setItems(prev => {
        let updated = prev;
        if (payload.all) {
          updated = prev.map(n => ({ ...n, read: true }));
        } else if (payload.ids) {
          updated = prev.map(n => payload.ids.includes(n.id) ? { ...n, read: true } : n);
        }
        onCountChange?.(updated.filter(n => !n.read).length);
        return updated;
      });
    };
    
    const unsubscribeCreated = subscribeSocket('notification.created', handleNewNotification);
    const unsubscribeRead = subscribeSocket('notification.read', handleReadNotification);
    
    // Refresh fully on socket reconnect to fetch anything missed while offline
    const handleReconnect = () => load();
    window.addEventListener('wev:socket_connect', handleReconnect);
    
    return () => {
      unsubscribeCreated();
      unsubscribeRead();
      window.removeEventListener('wev:socket_connect', handleReconnect);
    };
  }, [onCountChange]);

  const markRead = async (ids) => {
    const idsToMark = Array.isArray(ids) ? ids : [ids];
    setItems(prev => {
      const next = prev.map(n => idsToMark.includes(n.id) ? { ...n, read: true } : n);
      onCountChange?.(next.filter(n => !n.read).length);
      return next;
    });
    try { await api.markNotificationsRead({ ids: idsToMark }); } finally { load(); }
  };

  const markAllRead = async () => {
    setItems(prev => prev.map(n => ({ ...n, read: true })));
    onCountChange?.(0);
    try { await api.markNotificationsRead({ all: true }); } finally { load(); }
  };

  const open = (n) => {
    const idsToMark = n.isGroup ? n.originalItems.map(item => item.id) : [n.id];
    if (!n.read) markRead(idsToMark);
    if (n.link?.startsWith('event:')) onViewEvent?.(n.link.split(':')[1]);
    else if (n.link?.startsWith('/')) navigate(n.link);
  };

  const activeKinds = NOTIFICATION_FILTERS.find(f => f.id === filter)?.kinds;
  
  // 1. Group the items first (so a group of 3 updates becomes 1 item)
  const groupedItems = useMemo(() => groupNotifications(items), [items]);

  // 2. Filter the grouped items based on category and unread status
  const visible = useMemo(() => groupedItems.filter(n =>
    (!activeKinds || activeKinds.includes(n.kind)) && (!unreadOnly || !n.read)
  ), [groupedItems, activeKinds, unreadOnly]);

  const groups = useMemo(() => groupByDay(visible), [visible]);
  const unreadCount = items.filter(n => !n.read).length;

  // Counts per filter
  const countFor = (f) => {
    const pool = f.kinds ? groupedItems.filter(n => f.kinds.includes(n.kind)) : groupedItems;
    return unreadOnly ? pool.filter(n => !n.read).length : pool.length;
  };

  if (loading) {
    return <LoadingSkeleton className="stack" heights={[44, 44, 44, 44, 44]} />;
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
              onClick={() => withViewTransition(() => setFilter(f.id))}
            >
              {f.label}
              {countFor(f) > 0 && <span className="dim"> {countFor(f)}</span>}
            </button>
          ))}
        </div>

        <label className="check" style={{ padding: '0.375rem 0.625rem', border: 'none', marginLeft: 'auto' }}>
          <input type="checkbox" checked={unreadOnly} onChange={e => { const next = e.target.checked; withViewTransition(() => setUnreadOnly(next)); }} />
          <span className="small nowrap">Unread only</span>
        </label>

        {unreadCount > 0 && (
          <button className="btn btn-secondary btn-sm" onClick={markAllRead}>
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
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
        <div className="premium-list" style={{ background: 'var(--surface)', borderRadius: '16px', border: '1px solid var(--border)', overflow: 'hidden' }}>
          {groups.map((group, groupIdx) => (
            <section key={group.label}>
              <div className="section-head" style={{ padding: '16px', background: 'var(--surface-hover)', borderBottom: '1px solid var(--border)', margin: 0 }}>
                <h2 style={{ fontSize: '14px', margin: 0 }}>{group.label}</h2>
              </div>
              <div className="list" style={{ gap: 0 }}>
                {group.items.map(n => {
                  const meta = notificationMeta(n.kind);
                  const Icon = meta.icon;
                  const clickable = !!n.link;
                  const isCritical = n.priority === 'CRITICAL';
                  return (
                    <div
                      key={n.id}
                      className={`premium-notif-row ${n.read ? '' : 'is-unread'} ${isCritical ? 'is-critical' : ''}`}
                      role={clickable ? 'button' : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? () => open(n) : undefined}
                      onKeyDown={clickable ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(n); }
                      } : undefined}
                      style={{ ...rowTransitionStyle('nt', n.id), cursor: clickable ? 'pointer' : 'default', padding: '16px 20px' }}
                    >
                      <div className={`premium-notif-icon tone-${meta.tone} ${isCritical ? 'tone-critical' : ''}`}>
                        <Icon size={18} />
                      </div>

                      <div className="premium-notif-content">
                        <div className="row" style={{ gap: 'var(--s2)' }}>
                          <span className="premium-notif-title">
                            {n.title}
                            {n.isGroup && <span className="group-badge">{n.originalItems.length} updates</span>}
                          </span>
                        </div>
                        <p className="premium-notif-body" style={{ marginTop: 2 }}>{n.body}</p>
                        <p className="premium-notif-time" style={{ marginTop: 4 }}>
                          {timeAgo(n.createdAt)} · {formatDay(n.createdAt)}
                        </p>
                      </div>

                      {!n.read && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={e => { 
                            e.stopPropagation(); 
                            markRead(n.isGroup ? n.originalItems.map(item => item.id) : [n.id]); 
                          }}
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <p className="small dim row" style={{ gap: 6, justifyContent: 'center', marginTop: '16px' }}>
          <Bell size={12} /> Showing your {items.length} most recent notifications
        </p>
      )}
    </div>
  );
}
