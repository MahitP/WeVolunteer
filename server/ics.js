/**
 * RFC 5545 iCalendar serialisation.
 *
 * Extracted from eventRoutes so it can be tested against the specification
 * rather than against a substring. The previous inline version produced a file
 * no calendar application could open, and the test suite passed anyway because
 * it asserted `content.toContain('BEGIN:VCALENDAR')` — true of a single-line
 * blob just as much as of a valid file.
 *
 * Four separate violations were present:
 *
 *   1. Lines were joined with `'\\r\\n'` — inside a single-quoted JavaScript
 *      string that is an escaped backslash followed by `r`, so the output
 *      contained the four literal characters `\`, `r`, `\`, `n`. The file had
 *      zero line breaks and zero CR bytes: one content line, which §3.1 does
 *      not permit and no parser accepts.
 *   2. TEXT values were not escaped (§3.3.11). A comma in a TEXT value is a
 *      value-list separator, and the seeded event description contains several
 *      ("high school volunteers, or additional parents") — as do most street
 *      addresses in LOCATION. Unescaped, the value is truncated at the first
 *      comma or silently mangled.
 *   3. Content lines were not folded (§3.1). Lines MUST NOT exceed 75 octets;
 *      the description runs to roughly 250. Lenient parsers cope, strict ones
 *      and some Outlook builds do not.
 *   4. The final line carried no trailing CRLF, which §3.1 requires.
 */

/** RFC 5545 §3.3.11 — escape a TEXT property value. Order matters: backslash first. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // CRLF, CR and LF all collapse to the literal two-character escape `\n`.
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 §3.1 — fold a content line to 75 octets or fewer.
 *
 * Counted in OCTETS, not characters: the limit is on the encoded byte length, so
 * an emoji in an event title consumes four. Continuation lines begin with a
 * single space, which the parser strips when unfolding.
 *
 * A multi-byte character is never split across a fold, because a partial UTF-8
 * sequence would corrupt the value on unfold.
 */
export function foldLine(line, limit = 75) {
  const bytes = Buffer.from(String(line), 'utf8');
  if (bytes.length <= limit) return String(line);

  const out = [];
  let start = 0;
  let budget = limit;                     // first line: 75; continuations: 74 (leading space)

  while (start < bytes.length) {
    let end = Math.min(start + budget, bytes.length);
    // Back off until `end` sits on a UTF-8 character boundary. Continuation
    // bytes match 0b10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    budget = limit - 1;
  }

  return out[0] + out.slice(1).map(s => '\r\n ' + s).join('');
}

/** UTC form required by DTSTAMP/DTSTART/DTEND: `YYYYMMDDTHHMMSSZ`. */
export function formatIcsDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date for ICS: ${value}`);
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * A whole number of minutes, or null. Used for the alarm lead time.
 *
 * Rejects negatives (an alarm after the shift starts is not a reminder),
 * fractions (RFC 5545 durations are integral), and anything beyond a week —
 * past which a reminder is noise somebody will turn off along with the useful
 * ones.
 */
function normaliseReminderMinutes(value) {
  if (value == null) return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 7 * 24 * 60) return null;
  return minutes;
}

/**
 * Builds a single-event VCALENDAR for one shift.
 *
 * ── GEO, and why it is the closest thing to an ETA this app can honestly ship ──
 *
 * A calendar application that knows an event's coordinates can do something no
 * web page can: iOS Calendar's "Time to Leave" alert routes from wherever the
 * volunteer actually is, at the actual time, with live traffic, on the device,
 * and tells them when to leave. WeVolunteer cannot compute that — there is no
 * routing provider here, the Content-Security-Policy forbids calling one from
 * the browser, and the server has no origin to route from because student
 * coordinates are deliberately never stored.
 *
 * So the honest answer to "give volunteers an ETA" is to hand the question to
 * the one piece of software already holding every input, and this is the line
 * that does it. Two properties, no new vendor, nothing sent anywhere.
 *
 * GEO is a float pair separated by a semicolon (§3.8.1.6) and is NOT a TEXT
 * property, so it must not be run through `escapeText` — that would turn the
 * separator into `\;` and make the value unparseable.
 *
 * ── VALARM ──
 *
 * `reminderMinutes` emits a DISPLAY alarm that many minutes before the start.
 * The lead time comes from the volunteer rather than from a guess: we know how
 * far away the event is, we do not know whether they walk, cycle, take a bus or
 * get driven, and the difference between those is a factor of five.
 *
 * @returns {string} a complete .ics document, CRLF-delimited and CRLF-terminated
 */
export function buildShiftIcs({
  uid, start, end, summary, description, location, stamp,
  latitude, longitude, reminderMinutes,
}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WeVolunteer//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDate(stamp ?? new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `LOCATION:${escapeText(location)}`,
  ];

  /* Both or neither: a lone coordinate is not a place, and a GEO with one
     number is a malformed property rather than a partial one. */
  if (Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    lines.push(`GEO:${Number(latitude)};${Number(longitude)}`);
  }

  const minutes = normaliseReminderMinutes(reminderMinutes);
  if (minutes) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:-PT${minutes}M`,
      `DESCRIPTION:${escapeText(summary)}`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  // Fold each line, join with real CRLF, and terminate with CRLF per §3.1.
  return lines.map(l => foldLine(l)).join('\r\n') + '\r\n';
}
