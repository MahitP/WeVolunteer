import {
  ClipboardList, Calendar, Star, MessageSquare, UserRound, Settings, Bell
} from 'lucide-react';

/**
 * Maps each notification category to its icon, brand color, and label.
 */
export const NOTIFICATION_CATEGORIES = {
  APPLICATION: { icon: ClipboardList, tone: 'brand',  label: 'Applications' },
  EVENT:       { icon: Calendar,      tone: 'info',   label: 'Events' },
  VOLUNTEER:   { icon: Star,          tone: 'accent', label: 'Volunteering' },
  MESSAGES:    { icon: MessageSquare, tone: 'ok',     label: 'Messages' },
  ACCOUNT:     { icon: UserRound,     tone: 'muted',  label: 'Account' },
  SYSTEM:      { icon: Settings,      tone: 'warn',   label: 'System' },
};

export function notificationMeta(category) {
  return NOTIFICATION_CATEGORIES[category] || { icon: Bell, tone: 'muted', label: 'Notification' };
}

export const NOTIFICATION_FILTERS = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'applications', label: 'Applications', kinds: ['APPLICATION'] },
  { id: 'events', label: 'Events', kinds: ['EVENT'] },
  { id: 'volunteering', label: 'Volunteering', kinds: ['VOLUNTEER'] },
  { id: 'messages', label: 'Messages', kinds: ['MESSAGES'] }
];

/** Buckets notifications into Today / Yesterday / This Week / Earlier, newest first. */
export function groupByDay(items) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(new Date());
  const groups = new Map();

  for (const item of items) {
    const created = new Date(item.createdAt);
    const days = Math.round((today - startOfDay(created)) / 86400000);
    const label = days <= 0 ? 'Today'
      : days === 1 ? 'Yesterday'
      : days < 7 ? 'This week'
      : days < 30 ? 'This month'
      : 'Earlier';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }

  const order = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'];
  return order.filter(l => groups.has(l)).map(label => ({ label, items: groups.get(label) }));
}

/** 
 * Groups notifications intelligently:
 * Combines multiple notifications for the same event/context if they occurred recently.
 */
export function groupNotifications(items) {
  const grouped = [];
  const processed = new Set();
  
  for (const item of items) {
    if (processed.has(item.id)) continue;
    
    // Check if we can group this item with others
    const eventId = item.link?.startsWith('event:') ? item.link.split(':')[1] : null;
    
    if (eventId && item.kind === 'EVENT' && item.priority !== 'CRITICAL') {
      const similar = items.filter(other => 
        !processed.has(other.id) &&
        other.kind === 'EVENT' &&
        other.link === item.link &&
        other.priority !== 'CRITICAL' &&
        Math.abs(new Date(item.createdAt) - new Date(other.createdAt)) < 86400000 * 3 // within 3 days
      );
      
      if (similar.length > 1) {
        similar.forEach(s => processed.add(s.id));
        const unreadCount = similar.filter(s => !s.read).length;
        
        // Summarize changes if possible
        const allChanges = new Set();
        similar.forEach(s => {
          if (s.title.includes('details changed') && s.body.startsWith('Details changed: ')) {
            const changesText = s.body.replace('Details changed: ', '').replace('.', '');
            changesText.split(', ').forEach(c => allChanges.add(c));
          }
        });
        
        let bodyText = `${similar.length} new updates regarding this event.`;
        if (allChanges.size > 0) {
          bodyText = `Details changed: ${Array.from(allChanges).join(', ')}.`;
        }
        
        grouped.push({
          ...item,
          isGroup: true,
          title: `Updates for ${item.title.replace(/^(Event Updated|Event Cancelled|.* details changed|.*: )/, '') || 'Event'}`,
          body: bodyText,
          read: unreadCount === 0,
          originalItems: similar
        });
        continue;
      }
    }
    
    processed.add(item.id);
    grouped.push(item);
  }
  
  return grouped;
}
