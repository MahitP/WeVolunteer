import {
  CheckCircle2, Clock4, ArrowUpCircle, XCircle, CalendarClock, Bell,
  Megaphone, MapPin, Award, Ban, UserPlus, ShieldCheck, MessageSquare, Info
} from 'lucide-react';

/**
 * One place that decides how every notification kind looks and reads.
 *
 * `tone` maps to the status colours already in the design system, so an
 * acceptance is green and a cancellation is red without any component
 * inventing its own palette.
 */
export const NOTIFICATION_META = {
  accepted:     { icon: CheckCircle2,  tone: 'ok',     label: 'Accepted' },
  waitlisted:   { icon: Clock4,        tone: 'info',   label: 'Waitlisted' },
  promoted:     { icon: ArrowUpCircle, tone: 'ok',     label: 'Promoted' },
  declined:     { icon: XCircle,       tone: 'muted',  label: 'Not selected' },
  deadline:     { icon: CalendarClock, tone: 'warn',   label: 'Deadline' },
  reminder:     { icon: Bell,          tone: 'brand',  label: 'Reminder' },
  announcement: { icon: Megaphone,     tone: 'warn',   label: 'Update' },
  location:     { icon: MapPin,        tone: 'warn',   label: 'Location' },
  hours:        { icon: Award,         tone: 'accent', label: 'Hours' },
  cancelled:    { icon: Ban,           tone: 'danger', label: 'Cancelled' },
  application:  { icon: UserPlus,      tone: 'info',   label: 'Application' },
  approval:     { icon: ShieldCheck,   tone: 'ok',     label: 'Account' },
  comment:      { icon: MessageSquare, tone: 'info',   label: 'Question' },
  info:         { icon: Info,          tone: 'muted',  label: 'Info' }
};

export function notificationMeta(kind) {
  return NOTIFICATION_META[kind] || NOTIFICATION_META.info;
}

/**
 * Filter groups for the notification centre. Deliberately few — a student
 * should never have to think hard about which bucket something is in.
 */
export const NOTIFICATION_FILTERS = [
  { id: 'all', label: 'All', kinds: null },
  {
    id: 'applications',
    label: 'My applications',
    kinds: ['accepted', 'waitlisted', 'promoted', 'declined']
  },
  {
    id: 'events',
    label: 'Event updates',
    kinds: ['announcement', 'location', 'cancelled', 'reminder', 'deadline']
  },
  { id: 'hours', label: 'Hours', kinds: ['hours', 'approval'] }
];

/** Buckets notifications into Today / Yesterday / Earlier, newest first. */
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
