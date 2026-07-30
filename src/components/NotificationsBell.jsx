import React, { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ArrowRight, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { timeAgo } from '../utils/helpers';
import { notificationMeta, groupNotifications } from '../utils/notifications';
import { subscribeSocket } from '../services/socket';

/**
 * Premium quick-glance Notification Center. Answers "anything new?" in one click.
 * Integrates real-time Socket updates, intelligent grouping, and high-fidelity UI.
 */
export default function NotificationsBell({
  onViewEvent,
  onSeeAll,
  refreshKey
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({
    notifications: [],
    unreadCount: 0
  });
  const [loading, setLoading] = useState(true);
  const containerRef = useRef(null);
  const prevUnreadRef = useRef(0);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const newData = await api.fetchNotifications(30); // fetch more to allow grouping
      setData(newData);
      
      // Native Browser Notifications
      if (newData.unreadCount > prevUnreadRef.current && window.Notification && window.Notification.permission === 'granted') {
        const newNotifs = newData.unreadCount - prevUnreadRef.current;
        const latest = newData.notifications[0];
        const msg = newNotifs === 1 && latest ? `${latest.title}: ${latest.body}` : `You have ${newNotifs} new notification${newNotifs > 1 ? 's' : ''}`;
        new window.Notification('WeVolunteer', { body: msg });
      }
      prevUnreadRef.current = newData.unreadCount;
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
    // Real-time updates
    const handleNewNotification = (payload) => {
      setData(d => {
        const existing = d.notifications.find(n => n.id === payload.notification.id);
        if (existing) return d; // Prevent duplicates
        return {
          unreadCount: d.unreadCount + 1,
          notifications: [payload.notification, ...d.notifications]
        };
      });
    };
    
    const handleReadNotification = (payload) => {
      setData(d => {
        let updated = d.notifications;
        if (payload.all) {
          updated = d.notifications.map(n => ({ ...n, read: true }));
        } else if (payload.ids) {
          updated = d.notifications.map(n => payload.ids.includes(n.id) ? { ...n, read: true } : n);
        }
        return {
          unreadCount: updated.filter(n => !n.read).length,
          notifications: updated
        };
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
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = e => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('touchstart', onClick, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('touchstart', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markAllRead = async () => {
    setData(d => ({
      ...d,
      unreadCount: 0,
      notifications: d.notifications.map(n => ({ ...n, read: true }))
    }));
    try {
      await api.markNotificationsRead({ all: true });
    } finally {
      load();
    }
  };

  const markRead = async (ids) => {
    const idsToMark = Array.isArray(ids) ? ids : [ids];
    setData(d => ({
      ...d,
      unreadCount: Math.max(0, d.unreadCount - idsToMark.length),
      notifications: d.notifications.map(n => idsToMark.includes(n.id) ? { ...n, read: true } : n)
    }));
    try {
      await api.markNotificationsRead({ ids: idsToMark });
    } finally {
      load();
    }
  };

  const [perm, setPerm] = useState(window.Notification ? window.Notification.permission : 'denied');
  const requestPerm = async () => {
    if (!window.Notification) return;
    const res = await window.Notification.requestPermission();
    setPerm(res);
  };

  const handleClick = n => {
    const idsToMark = n.isGroup ? n.originalItems.map(item => item.id) : [n.id];
    if (!n.read) markRead(idsToMark);
    setOpen(false);
    if (n.link?.startsWith('event:')) onViewEvent?.(n.link.split(':')[1]);
    else if (n.link?.startsWith('/')) navigate(n.link);
  };

  const unread = data.unreadCount || 0;
  // Apply intelligent grouping for the popover (limit to top 10 items)
  const items = groupNotifications(data.notifications || []).slice(0, 10);

  return (
    <div ref={containerRef} className="bell">
      <button 
        className="btn btn-secondary btn-icon notif-trigger" 
        onClick={() => setOpen(o => !o)} 
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} 
        aria-expanded={open}
      >
        <Bell size={18} />
        {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="popover notifications-popover premium-popover" role="dialog" aria-label="Notifications">
          <div className="popover-head premium-head">
            <span className="popover-title">
              Notifications{unread > 0 && <span className="badge badge-brand">{unread} new</span>}
            </span>
            <div className="popover-actions">
              {unread > 0 && (
                <button className="btn btn-ghost btn-sm text-brand" onClick={markAllRead} title="Mark all as read">
                  <CheckCheck size={16} />
                </button>
              )}
              <button 
                className="btn btn-ghost btn-sm text-muted" 
                onClick={() => { setOpen(false); navigate('/settings'); }}
                title="Notification Settings"
              >
                <Settings size={16} />
              </button>
            </div>
          </div>
          
          {perm === 'default' && (
            <div className="alert alert-info premium-alert">
              <span>Enable browser notifications for real-time alerts.</span>
              <button className="btn btn-primary btn-sm" onClick={requestPerm}>Enable</button>
            </div>
          )}

          <div className="popover-scroll">
            {loading && items.length === 0 ? (
              <div className="stack-sm p-4">
                {[0, 1, 2].map(i => <div key={i} className="skeleton skeleton-row premium-skeleton" />)}
              </div>
            ) : items.length === 0 ? (
              <div className="empty premium-empty">
                <span className="empty-icon"><Bell size={24} /></span>
                <h3>You're all caught up</h3>
                <p>New updates and reminders will appear here.</p>
              </div>
            ) : (
              <div className="premium-list">
                {items.map(n => {
                  const meta = notificationMeta(n.kind) || {};
                  const Icon = meta.icon || Bell;
                  const isCritical = n.priority === 'CRITICAL';
                  return (
                    <button key={n.id} className={`premium-notif-row ${n.read ? '' : 'is-unread'} ${isCritical ? 'is-critical' : ''}`} onClick={() => handleClick(n)}>
                      <div className={`premium-notif-icon tone-${meta.tone} ${isCritical ? 'tone-critical' : ''}`}>
                        <Icon size={16} />
                      </div>
                      <div className="premium-notif-content">
                        <span className="premium-notif-title">
                          {n.title}
                          {n.isGroup && <span className="group-badge">{n.originalItems.length}</span>}
                        </span>
                        <span className="premium-notif-body">{n.body}</span>
                        <span className="premium-notif-time">{timeAgo(n.createdAt)}</span>
                      </div>
                      {!n.read && <div className="premium-unread-dot" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {onSeeAll && (
            <button className="popover-foot premium-foot" onClick={() => { setOpen(false); onSeeAll(); }}>
              See all notifications <ArrowRight size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
