/**
 * The conversation that collects a real event.
 *
 * ── What was here before ──
 *
 * "Create an event" produced this, immediately:
 *
 *     Event draft prepared:
 *     Title: Community Service Event
 *     Location: Community Center
 *     Spots: 10
 *
 * Nobody had said any of that. The organizer had asked to create an event and
 * been handed three invented facts to confirm — and confirming them failed,
 * because the payload was missing a field the API requires, which came back as
 * "I couldn't look that up just now." Two more turns of "confirm" then found no
 * draft (the first attempt had consumed it) and were answered by the language
 * model, which agreeably said the event was set up. Nothing had been created at
 * any point.
 *
 * ── What this is ──
 *
 * The state and the language of a multi-turn collection: what has been said so
 * far, what is still needed, how to read an answer, and how to describe the
 * result before anything is created. It holds no privileges and performs no
 * writes. The creation itself goes through `TOOLS.create_event` — the same
 * capability gate, the same `api.createEvent`, the same endpoint the Create
 * event page posts to — and `assistant.js` is what joins the two.
 *
 * ── Which fields, and why exactly these ──
 *
 * Read off the API, not chosen: `POST /api/events` refuses without `title`,
 * `description`, `category`, `location`, `applicationDeadline` and at least one
 * slot, and `server/validation.js` refuses a slot without a valid start, end
 * and capacity. So the collection asks for the name, the place, the day(s), the
 * hours and how many volunteers, one sentence about the work, and when
 * applications close.
 *
 * `category` is the one required field NOT asked for. It is a fixed vocabulary
 * the organizer has no reason to have memorised, `normalizeEventCategory` reads
 * it out of the words they have already used, and the choice is shown in the
 * summary before anything is created — so it is derived and visible rather than
 * invented and hidden. Everything else on the Create event page — instructions,
 * tags, an organization, auto-approve, attendee visibility — is optional there
 * and is not asked for here.
 *
 * ── The safety rules are the draft lifecycle's ──
 *
 * A collection is bound to the user who started it, expires, and is never
 * confirmable: it holds an INCOMPLETE event, and "confirm" against it must do
 * nothing. Only once every field is present and `validateEventPayload` passes
 * does `assistant.js` hand a finished payload to `confirm.js`, which is the
 * only thing "yes" can ever execute. See `confirm.js` for that half.
 */

import { validateEventPayload } from '../eventRules.js';
import { normalizeEventCategory } from './tools.js';
import { VALID_CATEGORIES } from '../eventCategories.js';

/**
 * How long a half-finished event survives.
 *
 * Six times the draft-confirmation window, because the two are different waits.
 * A confirmation is a single yes about something already on screen; this is a
 * conversation somebody may be having between other things — looking up a
 * venue, checking a date with somebody else. Five minutes would routinely
 * discard work an organizer was in the middle of, and the state is a few
 * strings on their own device that authorise nothing.
 */
const COLLECTION_EXPIRY_MS = 30 * 60 * 1000;

/** Applications close at the end of the working day unless told otherwise. */
const DEFAULT_DEADLINE_TIME = '17:00';

/** Server limits, so a value is trimmed here rather than refused there. */
const MAX_TITLE = 200;
const MAX_LOCATION = 300;
const MAX_DESCRIPTION = 5000;
const MAX_SHIFT_NAME = 100;

let collection = null;

/* ── State ───────────────────────────────────────────────────────────────── */

function emptyFields() {
  return {
    title: null,
    location: null,
    description: null,
    /** `YYYY-MM-DD`, ascending, unique. */
    dates: [],
    /** `{ name, startTime, endTime, maxSpots }`, times as `HH:MM`. */
    shifts: [],
    deadlineDate: null,
    deadlineTime: DEFAULT_DEADLINE_TIME,
    category: null,
    /** True once the organizer has named a category rather than it being read
        out of their words. See step 4 of `applyEventMessage`. */
    categoryStated: false,
  };
}

/** Start (or restart) a collection for this user. Returns the new state. */
export function beginEventDraft({ user = null } = {}) {
  const now = Date.now();
  collection = {
    id: `event-draft-${now}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user?.id ? String(user.id) : null,
    fields: emptyFields(),
    createdAt: now,
    expiresAt: now + COLLECTION_EXPIRY_MS,
  };
  return collection;
}

/**
 * The collection in progress for this user, or null.
 *
 * Expiry and identity are checked on every read, exactly as `getPendingDraft`
 * does: a collection started by one account must not be visible to the next one
 * to sign in on the same device.
 */
export function getEventDraft({ user = null } = {}) {
  if (!collection) return null;
  if (Date.now() > collection.expiresAt) {
    collection = null;
    return null;
  }
  if (user?.id && collection.userId && String(user.id) !== collection.userId) return null;
  return collection;
}

/** Forget the collection. Called on cancel, on completion, and by tests. */
export function clearEventDraft() {
  collection = null;
}

/* ── Reading dates, times and numbers out of ordinary sentences ───────────── */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const pad = n => String(n).padStart(2, '0');
const isoDay = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Midnight today, so "is this date in the past" is a question about days. */
function startOfToday(now) {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  return at;
}

/**
 * A year for a date given without one.
 *
 * "September 15" said in October means next September. Choosing the current
 * year unconditionally would produce a date in the past, which the deadline
 * rule then refuses for a reason the organizer never intended and cannot see.
 */
function inferYear(month, day, now) {
  const today = startOfToday(now);
  const thisYear = today.getFullYear();
  const candidate = new Date(thisYear, month, day);
  candidate.setHours(0, 0, 0, 0);
  return candidate < today ? thisYear + 1 : thisYear;
}

function validDay(year, month, day) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const at = new Date(year, month, day);
  return at.getMonth() === month && at.getDate() === day;
}

/**
 * Every date named in a message, as `YYYY-MM-DD`, in the order written.
 *
 * Four shapes, because organizers use all four: `2026-09-15`, `9/15`,
 * `September 15` (with "and 16" following it), and `15 September`. Plus
 * "today", "tomorrow" and "next Friday", which are the ones people type when
 * the event is soon.
 */
export function parseDates(text, { now = Date.now() } = {}) {
  const raw = String(text || '');
  const found = [];
  const add = day => { if (day && !found.includes(day)) found.push(day); };

  /* ISO first: it is unambiguous, and matching it here stops the numeric rule
     below reading `2026-09-15` as a 9/15. */
  const consumed = [];
  for (const m of raw.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const [, y, mo, d] = m;
    if (validDay(Number(y), Number(mo) - 1, Number(d))) {
      add(isoDay(Number(y), Number(mo) - 1, Number(d)));
      consumed.push([m.index, m.index + m[0].length]);
    }
  }
  const untouched = i => !consumed.some(([from, to]) => i >= from && i < to);

  /* `9/15`, `9/15/26`, `09/15/2026`. */
  for (const m of raw.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    if (!untouched(m.index)) continue;
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (month < 0 || month > 11) continue;
    let year;
    if (m[3]) year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    else year = inferYear(month, day, now);
    if (validDay(year, month, day)) add(isoDay(year, month, day));
  }

  /**
   * `September 15`, `Sept 15th, 2026`, and the trailing run that turns one date
   * into several: `September 15 and 16`, `Sept 15, 16 and 17`.
   *
   * The run only accepts one- and two-digit numbers, so the year in
   * "September 15, 2026" is not read as a second day.
   */
  const monthWord = Object.keys(MONTHS).join('|');
  const monthFirst = new RegExp(
    `\\b(${monthWord})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?((?:\\s*(?:,|and|&|\\+)\\s*\\d{1,2}(?:st|nd|rd|th)?(?!\\d))*)(?:\\s*,?\\s*(\\d{4}))?`,
    'gi',
  );
  for (const m of raw.matchAll(monthFirst)) {
    const month = MONTHS[m[1].toLowerCase()];
    const explicitYear = m[4] ? Number(m[4]) : null;
    const days = [Number(m[2])];
    if (m[3]) {
      for (const extra of m[3].matchAll(/(\d{1,2})(?:st|nd|rd|th)?/g)) days.push(Number(extra[1]));
    }
    for (const day of days) {
      const year = explicitYear ?? inferYear(month, day, now);
      if (validDay(year, month, day)) add(isoDay(year, month, day));
    }
  }

  /* `15 September`, `15th of September`. */
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthWord})[a-z]*\\.?(?:\\s*,?\\s*(\\d{4}))?`,
    'gi',
  );
  for (const m of raw.matchAll(dayFirst)) {
    const day = Number(m[1]);
    const month = MONTHS[m[2].toLowerCase()];
    const year = m[3] ? Number(m[3]) : inferYear(month, day, now);
    if (validDay(year, month, day)) add(isoDay(year, month, day));
  }

  const today = startOfToday(now);
  if (/\btoday\b/i.test(raw)) add(isoDay(today.getFullYear(), today.getMonth(), today.getDate()));
  if (/\btomorrow\b/i.test(raw)) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    add(isoDay(t.getFullYear(), t.getMonth(), t.getDate()));
  }
  for (const m of raw.matchAll(/\b(?:next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const target = WEEKDAYS[m[1].toLowerCase()];
    const at = new Date(today);
    /* Always forward, and never today: "this Friday" said on a Friday means the
       one coming, not the one being lived through. */
    let delta = (target - at.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    at.setDate(at.getDate() + delta);
    add(isoDay(at.getFullYear(), at.getMonth(), at.getDate()));
  }

  return found.sort();
}

/** `HH:MM` from a 12- or 24-hour reading. */
function clock(hour, minute, meridiem) {
  let h = hour;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (h > 23) return null;
  return `${pad(h)}:${pad(minute)}`;
}

const minutesOf = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * The time ranges named in a message, as `{ startTime, endTime }`.
 *
 * ── The meridiem problem ──
 *
 * "9 to 1" is how people write a morning shift, and read literally it ends
 * eight hours before it starts. So a missing am/pm is inferred from the other
 * end of the range, and when neither end has one, from the only reading that
 * runs forwards. Nothing here guesses a range that was not written; it only
 * decides which half of the clock an unqualified hour is on.
 */
export function parseTimeRange(text) {
  const raw = String(text || '');
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|until|til|till|through|thru)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/gi;
  const ranges = [];

  for (const m of raw.matchAll(pattern)) {
    const startHour = Number(m[1]);
    const startMin = Number(m[2] || 0);
    const endHour = Number(m[4]);
    const endMin = Number(m[5] || 0);
    if (startHour > 23 || endHour > 23 || startMin > 59 || endMin > 59) continue;

    const norm = s => (s ? s.replace(/\./g, '').toLowerCase() : null);
    let startMeridiem = norm(m[3]);
    let endMeridiem = norm(m[6]);

    /* A 24-hour reading identifies itself: an hour above 12, or a written
       ":00" on both ends with no am/pm anywhere. */
    const looks24 = !startMeridiem && !endMeridiem && (startHour > 12 || endHour > 12);

    if (!looks24) {
      if (!startMeridiem && endMeridiem) {
        /* "9 to 1 pm": the start shares the meridiem unless that would put it
           after the end. */
        startMeridiem = endMeridiem;
        if (minutesOf(clock(startHour, startMin, startMeridiem)) >= minutesOf(clock(endHour, endMin, endMeridiem))) {
          startMeridiem = endMeridiem === 'pm' ? 'am' : 'pm';
        }
      } else if (startMeridiem && !endMeridiem) {
        endMeridiem = startMeridiem;
        if (minutesOf(clock(endHour, endMin, endMeridiem)) <= minutesOf(clock(startHour, startMin, startMeridiem))) {
          endMeridiem = startMeridiem === 'am' ? 'pm' : 'am';
        }
      } else if (!startMeridiem && !endMeridiem) {
        /* Neither said. A range that already runs forwards is taken as
           written; one that does not is the "9 to 1" case, and the end is the
           afternoon. */
        if (endHour <= startHour) endMeridiem = 'pm';
      }
    }

    const startTime = clock(startHour, startMin, startMeridiem);
    const endTime = clock(endHour, endMin, endMeridiem);
    if (!startTime || !endTime) continue;
    if (minutesOf(endTime) <= minutesOf(startTime)) {
      /* Still backwards after all that — an evening shift written "8 to 2", or
         simply a mistake. Left as it is so `validateEventPayload` refuses it
         and the organizer is told, rather than being silently given hours they
         did not ask for. */
    }
    ranges.push({ startTime, endTime });
  }

  return ranges;
}

/** A single clock time, for a deadline given as "the 12th at 3pm". */
function parseSingleTime(text) {
  const m = String(text || '').match(/\b(?:at|by|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (!m) return null;
  const meridiem = m[3] ? m[3].replace(/\./g, '').toLowerCase() : null;
  const hour = Number(m[1]);
  if (!meridiem && hour <= 7) return null; /* "at 5" is more likely 5pm than 5am, but guessing is worse than the default. */
  return clock(hour, Number(m[2] || 0), meridiem);
}

/** How many volunteers a message asks for, or null. */
export function parseCapacity(text, { bareNumberCounts = false } = {}) {
  const raw = String(text || '');

  const explicit = raw.match(/\b(\d{1,3})\s*(?:more\s+)?(?:volunteers?|people|persons?|students?|helpers?|spots?|slots?|places?|seats?)\b/i);
  if (explicit) return Number(explicit[1]);

  const phrased = raw.match(/\b(?:need|needs|want|room for|space for|capacity of|capacity is|up to|max(?:imum)? of)\s+(\d{1,3})\b/i);
  if (phrased) return Number(phrased[1]);

  if (bareNumberCounts) {
    const bare = raw.match(/^\s*(\d{1,3})\s*$/);
    if (bare) return Number(bare[1]);
  }

  return null;
}

/* ── Reading a whole message ─────────────────────────────────────────────── */

const GENERIC_TITLES = new Set([
  '', 'a', 'an', 'the', 'event', 'events', 'new', 'volunteer', 'volunteering',
  'volunteer event', 'new event', 'one', 'it', 'something', 'shift', 'opportunity',
]);

/** A title stated outright, or named inside a request to create one. */
function parseTitle(text) {
  const raw = String(text || '').trim();

  const named = raw.match(/\b(?:called|named|titled?|title\s+is|name\s+is)\s+["“']?([^"”'.,;]+?)["”']?\s*(?:[.,;]|\s+\b(?:at|on|from|with|for|starting)\b|$)/i);
  if (named) {
    const value = named[1].trim();
    if (!GENERIC_TITLES.has(value.toLowerCase())) return value;
  }

  /**
   * `(?:another|an|a|the)` is ordered longest-first ON PURPOSE.
   *
   * Written `(?:a|an|the|another)` the engine takes `a` out of "an event",
   * leaves "n event" behind, and the event is created with the title "n". That
   * is not hypothetical — it is what this produced before the order was fixed.
   */
  const asked = raw.match(/\b(?:create|make|set ?up|schedule|post|add|start|new|organi[sz]e|run|host)\s+(?:(?:another|an|a|the)\s+)?(.+?)\s*(?=\s\b(?:at|on|from|with|for|starting|running)\b|[.,;!?]|$)/i);
  if (asked) {
    const value = asked[1].trim().replace(/\s+event$/i, '').trim();
    if (!GENERIC_TITLES.has(value.toLowerCase())) return sentenceCase(value);
  }

  return null;
}

/**
 * A title lifted out of the middle of a sentence, given a capital.
 *
 * "set up a park cleanup at Reichler Park" yields "park cleanup", which is
 * exactly what the organizer wrote and is not what they would have written in
 * a title field — the words were mid-sentence, so they were lower case for
 * grammatical reasons rather than deliberate ones. Only the first letter, and
 * only when there is no capital anywhere in the string, so a name that was
 * cased on purpose is never re-cased. A title typed as a direct ANSWER is not
 * put through this at all: that one is a title, exactly as given.
 */
function sentenceCase(value) {
  if (/[A-Z]/.test(value)) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A place stated outright. */
function parseLocation(text) {
  const raw = String(text || '').trim();

  const stated = raw.match(/\b(?:location|venue|place)\s*(?:is|will be|:)\s*(.+?)\s*(?=[.;]|\s+\b(?:on|from|with|starting)\b|$)/i);
  if (stated) return cleanPlace(stated[1]);

  const at = raw.match(/\b(?:at|in)\s+(?:the\s+)?(.+?)\s*(?=[.,;]|\s+\b(?:on|from|with|starting|running|between)\b|$)/i);
  if (at) return cleanPlace(at[1]);

  return null;
}

/** Reject an "at" that was introducing a time rather than a place. */
function cleanPlace(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (/^\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)?$/i.test(text)) return null;
  if (/^(noon|midday|midnight)$/i.test(text)) return null;
  return text.slice(0, MAX_LOCATION);
}

/** Where a deadline is stated in its own words. */
function parseDeadline(text, { now }) {
  const raw = String(text || '');
  const clause = raw.match(
    /\b(?:applications?|sign-?ups?|registrations?|deadline|apply)\b[^.;]*?\b(?:close|closes|closing|end|ends|due|is|by|until|deadline)\b([^.;]*)/i,
  );
  const scope = clause ? clause[1] : null;
  if (!scope) return null;
  const dates = parseDates(scope, { now });
  if (!dates.length) return null;
  return { date: dates[0], time: parseSingleTime(scope) };
}

/**
 * An explicit correction — "change the location to the gym", "actually the
 * name is Winter Food Drive", "make it 30 spots".
 *
 * Kept separate from ordinary extraction because a correction has to win: the
 * same sentence may mention the old value too, and the point of saying "change"
 * is that the second one is meant.
 */
export function parseCorrections(text, { now = Date.now() } = {}) {
  const raw = String(text || '');
  const out = {};

  const FIELD_WORDS = {
    name: 'title', title: 'title',
    location: 'location', place: 'location', venue: 'location', address: 'location',
    date: 'dates', dates: 'dates', day: 'dates', days: 'dates',
    time: 'shifts', times: 'shifts', shift: 'shifts', shifts: 'shifts', hours: 'shifts',
    spots: 'maxSpots', capacity: 'maxSpots', volunteers: 'maxSpots', slots: 'maxSpots',
    deadline: 'deadline',
    description: 'description', details: 'description',
    category: 'category', type: 'category',
  };
  const words = Object.keys(FIELD_WORDS).join('|');

  const directive = new RegExp(
    `\\b(?:change|set|update|correct|edit|rename|make)\\s+(?:the\\s+|its\\s+|it'?s\\s+)?(${words})\\s+(?:to|as|:)\\s*["“']?([^"”';]+?)["”']?\\s*(?:[.;]|$)`,
    'i',
  );
  const restated = new RegExp(
    `\\b(?:actually|instead|sorry|no,?)[,\\s]+(?:the\\s+|its\\s+|it'?s\\s+)?(${words})\\s+(?:is|should be|will be|needs to be)\\s*["“']?([^"”';]+?)["”']?\\s*(?:[.;]|$)`,
    'i',
  );

  for (const pattern of [directive, restated]) {
    const m = raw.match(pattern);
    if (!m) continue;
    const field = FIELD_WORDS[m[1].toLowerCase()];
    const value = m[2].trim();
    if (!value) continue;

    if (field === 'title') out.title = value.slice(0, MAX_TITLE);
    else if (field === 'location') out.location = cleanPlace(value);
    else if (field === 'description') out.description = value.slice(0, MAX_DESCRIPTION);
    else if (field === 'category') out.category = normalizeEventCategory(value);
    else if (field === 'dates') {
      const dates = parseDates(value, { now });
      if (dates.length) out.dates = dates;
    } else if (field === 'shifts') {
      const ranges = parseTimeRange(value);
      if (ranges.length) out.shiftTimes = ranges;
    } else if (field === 'maxSpots') {
      const n = parseCapacity(value, { bareNumberCounts: true });
      if (n) out.maxSpots = n;
    } else if (field === 'deadline') {
      const dates = parseDates(value, { now });
      if (dates.length) out.deadline = { date: dates[0], time: parseSingleTime(value) };
    }
  }

  /* "make it 30 spots" / "make it 30 volunteers" — the commonest correction
     there is, and it names no field word at all. */
  const spots = raw.match(/\b(?:make|change)\s+it\s+(\d{1,3})\b/i);
  if (spots) out.maxSpots = Number(spots[1]);

  return out;
}

/**
 * Blank out the date-shaped parts of a message.
 *
 * ── The bug this closes ──
 *
 * `2026-09-20` is also a perfectly good time range: `parseTimeRange` reads it
 * as 09:00 to 20:00, because "09-20" is two numbers with a dash between them.
 * An organizer answering "What date is it on?" with an ISO date therefore had
 * a shift silently invented from their answer, and the real hours they gave a
 * question later were then ignored as already known — an eleven-hour shift
 * nobody asked for, on a form that had already stopped asking.
 *
 * `9/15` and "September 15-16" fail the same way. So the dates are read first
 * and their text is replaced with spaces before anything looks for hours or
 * counts. Spaces rather than removal, so word boundaries either side survive.
 */
function maskDates(text) {
  const monthWord = Object.keys(MONTHS).join('|');
  return String(text || '')
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, m => ' '.repeat(m.length))
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, m => ' '.repeat(m.length))
    .replace(
      new RegExp(
        `\\b(?:${monthWord})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*(?:,|and|&|\\+|-|–)\\s*\\d{1,2}(?:st|nd|rd|th)?(?!\\d))*(?:\\s*,?\\s*\\d{4})?`,
        'gi',
      ),
      m => ' '.repeat(m.length),
    )
    .replace(
      new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${monthWord})[a-z]*\\.?(?:\\s*,?\\s*\\d{4})?`, 'gi'),
      m => ' '.repeat(m.length),
    );
}

/** Every fact a message offers, whether or not it was the one asked for. */
function extractFacts(text, { asked, now }) {
  const raw = String(text || '').trim();
  const facts = {};

  const title = parseTitle(raw);
  if (title) facts.title = title.slice(0, MAX_TITLE);

  const location = parseLocation(raw);
  if (location) facts.location = location;

  const dates = parseDates(raw, { now });
  const deadline = parseDeadline(raw, { now });
  if (deadline) facts.deadline = deadline;

  /* A date that belongs to the deadline clause is not one of the event's days. */
  const eventDates = deadline ? dates.filter(d => d !== deadline.date) : dates;
  if (eventDates.length) facts.dates = eventDates;

  /* Hours and counts are read from the message with its dates blanked out —
     see `maskDates`. */
  const dateless = maskDates(raw);

  const ranges = parseTimeRange(dateless);
  if (ranges.length) facts.shiftTimes = ranges;

  const capacity = parseCapacity(dateless, { bareNumberCounts: asked === 'shifts' });
  if (capacity) facts.maxSpots = capacity;

  return facts;
}

/* ── The collection itself ───────────────────────────────────────────────── */

/** Field order, which is also the order the questions are asked in. */
const FIELD_ORDER = ['title', 'location', 'dates', 'shifts', 'description', 'deadline'];

/**
 * The first thing still missing, or null when the event is complete.
 *
 * A shift is complete only with its hours AND its capacity. Both halves are
 * checked because either can arrive first: "20 volunteers" answers the shift
 * question without saying when, and "9 to 1" answers it without saying how
 * many. Checking only the capacity — which this did — let a shift with no
 * hours count as finished, and `buildEventPayload` then tried to build an
 * instant out of a null time.
 */
export function missingField(draft) {
  const f = draft?.fields;
  if (!f) return 'title';
  if (!f.title) return 'title';
  if (!f.location) return 'location';
  if (!f.dates.length) return 'dates';
  if (!f.shifts.length) return 'shifts';
  if (f.shifts.some(s => !s.startTime || !s.endTime || !s.maxSpots)) return 'shifts';
  if (!f.description) return 'description';
  if (!f.deadlineDate) return 'deadline';
  return null;
}

/** What to ask for one field. */
export function questionFor(field, draft = null) {
  switch (field) {
    case 'title':
      return "Sure — let's set it up. What's the event called?";
    case 'location':
      return 'Where will it be held?';
    case 'dates':
      return 'What date is it on? If it runs over more than one day, give me all of them.';
    case 'shifts': {
      /* Ask for the half that is missing, not for both again. */
      const f = draft?.fields;
      const haveTimes = Boolean(f?.shifts.length) && f.shifts.every(s => s.startTime && s.endTime);
      const haveSpots = Boolean(f?.shifts.length) && f.shifts.every(s => s.maxSpots);
      if (haveTimes && !haveSpots) return 'How many volunteers do you need for that shift?';
      if (haveSpots && !haveTimes) return 'What time does the shift run?';
      return 'What time does the shift run, and how many volunteers do you need?';
    }
    case 'description':
      return 'What will volunteers be doing? A sentence is plenty — it goes on the listing.';
    case 'deadline':
      return 'When should applications close? It has to be on or before the first shift starts.';
    default:
      return 'What else should I know?';
  }
}

/**
 * Fold a message into the collection.
 *
 * Returns `{ draft, understood, applied }`. `understood` is false when nothing
 * in the message could be read as an answer to the question that was asked,
 * which is the assistant's cue to ask again rather than to store a shrug as an
 * event title.
 */
export function applyEventMessage(message, { user = null, now = Date.now(), revising = false, initial = false } = {}) {
  const draft = getEventDraft({ user });
  if (!draft) return null;

  const raw = String(message || '').trim();
  const asked = missingField(draft);
  const applied = [];
  const f = draft.fields;

  const setTitle = value => { f.title = value; applied.push('title'); };
  const setLocation = value => { f.location = value; applied.push('location'); };
  const setDescription = value => { f.description = value; applied.push('description'); };
  const setDates = value => { f.dates = value; applied.push('dates'); };
  /* Stated outright, which stops the derivation below overwriting it when
     something else in the event changes. */
  const setCategory = value => {
    f.category = value;
    f.categoryStated = true;
    applied.push('category');
  };

  const setShiftTimes = ranges => {
    const carriedSpots = f.shifts.find(s => s.maxSpots)?.maxSpots ?? null;
    f.shifts = ranges.map((r, i) => ({
      name: f.shifts[i]?.name ?? null,
      startTime: r.startTime,
      endTime: r.endTime,
      maxSpots: f.shifts[i]?.maxSpots ?? carriedSpots,
    }));
    applied.push('shifts');
  };

  /**
   * ── The number is theirs, and is not quietly adjusted ──
   *
   * This used to clamp to 1–100, which is the server's range. An organizer who
   * said "500 volunteers" got an event for 100, with the substitution shown
   * nowhere and mentioned by nobody — a number nobody chose, published under
   * their name. It is the same fault as the invented "Community Center" this
   * whole flow replaced, in a quieter place.
   *
   * So what they said is what is stored, and `validateEventPayload` — the
   * server's own function — is what refuses it, in the server's own words.
   */
  const setCapacity = n => {
    const stated = Math.round(n);
    if (!f.shifts.length) {
      /* Capacity before times: remembered on a shift with no hours yet, so the
         next question is about the hours and not about this again. */
      f.shifts = [{ name: null, startTime: null, endTime: null, maxSpots: stated }];
    } else {
      f.shifts = f.shifts.map(s => ({ ...s, maxSpots: stated }));
    }
    applied.push('maxSpots');
  };

  const setDeadline = ({ date, time }) => {
    f.deadlineDate = date;
    if (time) f.deadlineTime = time;
    applied.push('deadline');
  };

  /* 1. Corrections win over everything else in the same message. */
  const corrections = parseCorrections(raw, { now });
  if (corrections.title) setTitle(corrections.title);
  if (corrections.location) setLocation(corrections.location);
  if (corrections.description) setDescription(corrections.description);
  if (corrections.category) setCategory(corrections.category);
  if (corrections.dates) setDates(corrections.dates);
  if (corrections.shiftTimes) setShiftTimes(corrections.shiftTimes);
  if (corrections.maxSpots) setCapacity(corrections.maxSpots);
  if (corrections.deadline) setDeadline(corrections.deadline);

  /**
   * 2. Everything else the message happens to say, for fields not yet set.
   *
   * `revising` is the confirmation stage, where every field IS set and a date,
   * a time or a count can only be a change to one. It deliberately does not
   * extend to the free-text fields: "the gym is quite far" must not become the
   * event's new name because it arrived while a summary was on screen. Those
   * need "change the name to …", which `parseCorrections` reads above.
   */
  const facts = extractFacts(raw, { asked, now });
  if (!f.title && facts.title) setTitle(facts.title);
  if (!f.location && facts.location) setLocation(facts.location);
  if ((revising || !f.dates.length) && facts.dates) setDates(facts.dates);
  if ((revising || !f.shifts.some(s => s.startTime)) && facts.shiftTimes) setShiftTimes(facts.shiftTimes);
  if ((revising || !f.shifts.some(s => s.maxSpots)) && facts.maxSpots) setCapacity(facts.maxSpots);
  if ((revising || !f.deadlineDate) && facts.deadline) setDeadline(facts.deadline);

  /**
   * A bare date in answer to "when should applications close?".
   *
   * `parseDeadline` only fires on a message that names the deadline — "sign-ups
   * close on the 12th" — and the commonest answer to the question does not,
   * because the question already said what the date is for. Without this the
   * date is read as another day of the event, the deadline stays unset, and the
   * same question is asked for ever.
   */
  if (asked === 'deadline' && !f.deadlineDate && facts.dates?.length) {
    setDeadline({ date: facts.dates[0], time: parseSingleTime(raw) });
  }

  /**
   * 3. The answer to the question actually asked, taken whole.
   *
   * Only for the three free-text fields, and only when the patterns above found
   * nothing — an organizer answering "Where?" with "the community center" has
   * written a location and not a sentence containing one.
   *
   * `initial` switches it off for the message that STARTED the conversation,
   * which is never an answer to anything: "create an event" would otherwise
   * become the event's name, since no question had been asked when it arrived.
   */
  if (raw && !initial && !applied.length) {
    if (asked === 'title') setTitle(raw.slice(0, MAX_TITLE));
    else if (asked === 'location') {
      const place = cleanPlace(raw);
      if (place) setLocation(place);
    } else if (asked === 'description') setDescription(raw.slice(0, MAX_DESCRIPTION));
  }

  /**
   * 4. The category is derived, never asked for, and follows the words used.
   *
   * Re-derived whenever the words it was derived FROM change, so renaming
   * "Community Event" to "Winter Coat Drive" moves it out of Other. Never when
   * the organizer has named a category themselves — a derivation must not
   * quietly overrule a statement.
   */
  const wordsChanged = applied.includes('title') || applied.includes('description');
  if (f.title && !f.categoryStated && (!f.category || wordsChanged)) {
    f.category = normalizeEventCategory(`${f.title} ${f.description || ''}`.trim());
  }

  draft.expiresAt = now + COLLECTION_EXPIRY_MS;

  return { draft, understood: applied.length > 0, applied };
}

/* ── Turning the collection into the thing the API takes ──────────────────── */

/**
 * Local `YYYY-MM-DDTHH:MM` → an ISO instant, the way CreateEvent does it.
 *
 * Null rather than a throw for an unparseable pair. `missingField` is what
 * stops an incomplete shift getting here, and a guard that turns a logic error
 * into a refused event is better than one that turns it into an exception
 * inside a conversation.
 */
function instant(day, time) {
  if (!day || !time) return null;
  const at = new Date(`${day}T${time}:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The `POST /api/events` payload, or null while anything is still missing.
 *
 * One slot per date per shift — the same cross-product the Create event page
 * builds when an organizer adds a shift "to all dates".
 */
export function buildEventPayload(draft) {
  if (!draft || missingField(draft)) return null;
  const f = draft.fields;

  const deadline = instant(f.deadlineDate, f.deadlineTime);
  if (!deadline) return null;

  const slots = [];
  for (const day of f.dates) {
    for (const shift of f.shifts) {
      const startDatetime = instant(day, shift.startTime);
      const endDatetime = instant(day, shift.endTime);
      if (!startDatetime || !endDatetime) return null;
      slots.push({
        /* The organizer's own words when they have not named the shift
           separately — never an invented label. */
        name: (shift.name || f.title).slice(0, MAX_SHIFT_NAME),
        description: '',
        startDatetime,
        endDatetime,
        maxSpots: shift.maxSpots,
      });
    }
  }

  return {
    title: f.title.slice(0, MAX_TITLE),
    description: f.description.slice(0, MAX_DESCRIPTION),
    category: VALID_CATEGORIES.includes(f.category) ? f.category : normalizeEventCategory(f.title),
    location: f.location.slice(0, MAX_LOCATION),
    applicationDeadline: deadline,
    slots,
  };
}

/* ── Saying it back ──────────────────────────────────────────────────────── */

const dayWords = iso => {
  const at = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(at.getTime())) return iso;
  try {
    return at.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
};

const timeWords = hhmm => {
  const at = new Date(`2000-01-01T${hhmm}:00`);
  if (Number.isNaN(at.getTime())) return hhmm;
  try {
    return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return hhmm;
  }
};

/** The whole event in the words it will be created with. */
export function describeEventDraft(draft) {
  const f = draft.fields;
  const lines = [
    `Name: ${f.title}`,
    `Where: ${f.location}`,
    `When: ${f.dates.map(dayWords).join(', ')}`,
  ];
  for (const shift of f.shifts) {
    lines.push(
      `Shift: ${timeWords(shift.startTime)}–${timeWords(shift.endTime)}, `
      + `${shift.maxSpots} volunteer${shift.maxSpots === 1 ? '' : 's'}`
      + (f.dates.length > 1 ? ' on each day' : ''),
    );
  }
  lines.push(`Applications close: ${dayWords(f.deadlineDate)} at ${timeWords(f.deadlineTime)}`);
  lines.push(`Category: ${f.category}`);
  lines.push(`Description: ${f.description}`);
  return lines.join('\n');
}

/**
 * Why this event cannot be created, in ordinary English, or null when it can.
 *
 * ── The rules are the server's ──
 *
 * `validateEventPayload` decides. It is the same function `POST /api/events`
 * runs, imported through `src/eventRules.js` rather than reimplemented, so
 * Welly's answer to "can this be created?" is the answer the API will give.
 *
 * ── What this adds ──
 *
 * The dates. The server's own sentence — "The application deadline must be on
 * or before the first shift starts." — is correct and general, and an organizer
 * reading it still has to work out which of their dates is the problem. Where
 * the failure is worth naming with the actual days, this says them. Everywhere
 * else the server's sentence is used verbatim, which is what keeps a new rule
 * from surfacing as a code or a shrug.
 */
export function explainInvalidEvent(payload) {
  const verdict = validateEventPayload(payload);
  if (verdict.ok) return null;
  /* `field` tells the caller which answer to ask for again, so the organizer's
     next message is read as the correction rather than as free text. */

  const starts = payload.slots
    .map(s => Date.parse(s.startDatetime))
    .filter(n => !Number.isNaN(n));
  const firstStart = starts.length ? Math.min(...starts) : null;
  const deadline = Date.parse(payload.applicationDeadline);
  const asDay = ms => dayWords(new Date(ms).toISOString().slice(0, 10));
  const asMoment = ms => `${asDay(ms)} at ${timeWords(new Date(ms).toTimeString().slice(0, 5))}`;

  /* The rule the reader is most likely to hit, and the one worth naming with
     both dates: applications that close after the event has already started. */
  if (firstStart != null && !Number.isNaN(deadline) && deadline > firstStart) {
    return {
      field: 'deadline',
      message: "I can't create this event yet, because applications would still be open after it "
        + `has started. The first shift is on ${asMoment(firstStart)}, but applications are set to `
        + `close on ${asMoment(deadline)}. The deadline has to be on or before the first shift `
        + 'begins — tell me a new closing date and I will use that.',
    };
  }

  if (!Number.isNaN(deadline) && deadline <= Date.now()) {
    return {
      field: 'deadline',
      message: "I can't create this event yet, because the date applications close — "
        + `${asMoment(deadline)} — has already passed. Give me a closing date in the future and I `
        + 'will use that.',
    };
  }

  const badShift = payload.slots.find(s => {
    const start = Date.parse(s.startDatetime);
    const end = Date.parse(s.endDatetime);
    return !Number.isNaN(start) && !Number.isNaN(end) && end <= start;
  });
  if (badShift) {
    const start = Date.parse(badShift.startDatetime);
    const end = Date.parse(badShift.endDatetime);
    return {
      field: 'shifts',
      message: "I can't create this event yet, because one of the shifts ends before it starts — "
        + `${asMoment(start)} to ${asMoment(end)}. Tell me the right hours and I will fix it.`,
    };
  }

  /* Anything else the server refuses. Its own sentence, which is written to be
     read: "Each shift must allow between 1 and 100 volunteers.", "A single
     shift cannot be longer than 24 hours." and the rest. */
  /**
   * Which answer to ask for again, for the rules whose message names one.
   *
   * A shift longer than the cap is a mistyped hour far more often than a
   * genuine intention, so the hours are what to re-ask. A capacity outside the
   * permitted range is a number the organizer meant and cannot have, so the
   * number is what to re-ask — and re-asking it is the whole point: without a
   * field to go back to, "make it 50" has nowhere to land and the conversation
   * dead-ends on a refusal.
   *
   * The capacity case is decided from the PAYLOAD rather than from the wording
   * of the refusal. Reading it out of the message would tie this to a sentence
   * that belongs to `server/validation.js` and is free to change; the numbers
   * cannot drift from themselves.
   */
  const outOfRange = payload.slots.some(slot => {
    const spots = Number(slot?.maxSpots);
    return !Number.isInteger(spots) || spots < 1 || spots > 100;
  });

  const retreat = outOfRange
    ? 'capacity'
    : /longer than \d+ hours/i.test(verdict.error)
      ? 'shifts'
      : null;

  return { field: retreat, message: `I can't create this event yet — ${lowerFirst(verdict.error)}` };
}

function lowerFirst(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return 'something about it is not valid.';
  /* Only when the first word is an ordinary one; "Each shift…" lowercases
     cleanly, and nothing in the rule set starts with a proper noun. */
  return text[0].toLowerCase() + text.slice(1);
}

/** Field order, exported so a test can assert the questions cover the API's needs. */
export const COLLECTED_FIELDS = Object.freeze(FIELD_ORDER);
