/**
 * Formats a decimal hour value into a user-friendly string (e.g., 1.5 -> "1 hr 30 min", 0.75 -> "45 min")
 * @param {number|string} hours - The decimal hour value (e.g., 1.5, 2.25)
 * @returns {string} Formatted duration string
 */
export function formatHours(hours) {
  const h = Number(hours);
  // "0 hrs" rather than "0 min" — this reads as a headline figure on
  // dashboards, where "0 min" scans as a duration bug.
  if (isNaN(h) || h <= 0) return '0 hrs';
  
  const totalMinutes = Math.round(h * 60);
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  
  const hrsStr = hrs > 0 ? `${hrs} hr${hrs === 1 ? '' : 's'}` : '';
  const minsStr = mins > 0 ? `${mins} min` : '';
  
  if (hrsStr && minsStr) {
    return `${hrsStr} ${minsStr}`;
  }
  return hrsStr || minsStr;
}

/**
 * Converts an ISO datetime string to the local "YYYY-MM-DDTHH:mm" format that
 * <input type="datetime-local"> expects. Slicing the raw ISO string instead
 * would show UTC time, shifted from what the rest of the UI displays.
 * @param {string} iso - ISO 8601 datetime string
 * @returns {string} Local datetime-local input value, or '' if invalid
 */
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Whether an event picks volunteers automatically after the deadline.
 *
 * The API still carries this as `autoApprove` for backwards compatibility, but
 * that name predates the feature: nothing is approved on application any more.
 * Reading it through here keeps call sites honest about what it means.
 * @param {object} event
 * @returns {boolean}
 */
export function usesAutoSelect(event) {
  return !!event?.autoApprove;
}

/** Human label for how an event chooses volunteers. */
export function selectionMethodLabel(event) {
  return usesAutoSelect(event) ? 'Auto Select' : 'Manual review';
}

/**
 * Grade as people say it: "Grade 11", but just "Adult" for non-students.
 * @param {string} grade
 * @returns {string}
 */
export function gradeLabel(grade) {
  if (!grade || grade === 'N/A') return '';
  return /^\d+$/.test(String(grade)) ? `Grade ${grade}` : String(grade);
}

/**
 * Short weekday + date, e.g. "Sat, Jul 11".
 * @param {string} iso
 * @returns {string}
 */
export function formatDay(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Clock time without a leading zero, e.g. "7:30 AM".
 * @param {string} iso
 * @returns {string}
 */
export function formatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Time span for a shift, e.g. "7:30 AM – 9:30 AM".
 * @param {string} startIso
 * @param {string} endIso
 * @returns {string}
 */
export function formatTimeRange(startIso, endIso) {
  return `${formatTime(startIso)} – ${formatTime(endIso)}`;
}

/**
 * Plain-language countdown used for upcoming shifts and deadlines.
 * @param {string} iso
 * @returns {string} e.g. "Today", "Tomorrow", "In 5 days", "Passed"
 */
export function countdown(iso) {
  const target = new Date(iso);
  if (isNaN(target.getTime())) return '';
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(target) - startOfDay(new Date())) / 86400000);
  if (days < 0) return 'Passed';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  if (days < 14) return 'Next week';
  return `In ${Math.round(days / 7)} weeks`;
}

/**
 * Human-friendly relative timestamp (e.g. "5m ago", "2d ago").
 * @param {string} iso - ISO 8601 datetime string
 * @returns {string}
 */
export function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
