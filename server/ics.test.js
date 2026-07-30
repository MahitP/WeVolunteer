import { describe, it, expect } from 'vitest';
import { buildShiftIcs, escapeText, foldLine, formatIcsDate } from './ics.js';

/**
 * RFC 5545 conformance.
 *
 * The previous ICS test asserted `content.toContain('BEGIN:VCALENDAR')` and five
 * similar substrings — every one of which is satisfied by a single-line blob with
 * literal `\r\n` text in it, which is exactly what shipped. Substring assertions
 * cannot tell a valid calendar from an invalid one.
 *
 * These tests therefore UNFOLD AND PARSE the output the way a calendar client
 * does, and assert on the parsed result. The `parse` helper below is deliberately
 * strict: it refuses anything a real client would refuse.
 */

/**
 * Minimal RFC 5545 reader: unfold (§3.1), then split into name/value pairs.
 * Throws on the structural violations that matter.
 */
function parse(ics) {
  if (!ics.endsWith('\r\n')) throw new Error('§3.1: document must end with CRLF');
  if (/(^|[^\r])\n/.test(ics)) throw new Error('§3.1: bare LF present — line breaks must be CRLF');
  if (ics.includes('\\r\\n')) throw new Error('literal "\\r\\n" text found instead of a real CRLF');

  // Unfold: CRLF followed by a single space or tab is a continuation.
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const lines = unfolded.split('\r\n').filter(l => l.length > 0);

  if (lines[0] !== 'BEGIN:VCALENDAR') throw new Error('§3.4: first line must be BEGIN:VCALENDAR');
  if (lines[lines.length - 1] !== 'END:VCALENDAR') throw new Error('§3.4: last line must be END:VCALENDAR');

  const props = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`malformed content line: ${line.slice(0, 40)}`);
    props[line.slice(0, i)] = line.slice(i + 1);
  }
  return { lines, props, unfolded };
}

/** Every physical line must be <= 75 octets (§3.1). */
function longestOctetLine(ics) {
  return Math.max(...ics.split('\r\n').map(l => Buffer.byteLength(l, 'utf8')));
}

const SHIFT = {
  uid: 'slot-1@wevolunteer.org',
  start: '2026-08-11T07:30:00.000Z',
  end: '2026-08-11T09:30:00.000Z',
  summary: 'Softball Snack Shack (Adult)',
  description: 'Bring the cash box.',
  location: 'Reichler Park',
  stamp: '2026-07-30T12:00:00.000Z'
};

describe('ICS structure (§3.1, §3.4)', () => {
  it('uses real CRLF line breaks, not the literal text "\\r\\n"', () => {
    const ics = buildShiftIcs(SHIFT);
    // The exact regression: 0x5c 0x72 0x5c 0x6e in the byte stream.
    expect(ics).not.toContain('\\r\\n');
    expect(ics).toContain('\r\n');
    const bytes = Buffer.from(ics, 'utf8');
    expect(bytes.includes(0x0d)).toBe(true);   // CR present
    expect(bytes.includes(0x0a)).toBe(true);   // LF present
  });

  it('produces more than one physical line', () => {
    const ics = buildShiftIcs(SHIFT);
    // The shipped file was exactly one line. This is the cheapest possible
    // assertion that would have caught it.
    expect(ics.split('\r\n').filter(Boolean).length).toBeGreaterThan(10);
  });

  it('terminates the document with CRLF', () => {
    expect(buildShiftIcs(SHIFT).endsWith('\r\n')).toBe(true);
  });

  it('parses cleanly with a strict reader', () => {
    const { props } = parse(buildShiftIcs(SHIFT));
    expect(props['BEGIN']).toBeDefined();
    expect(props['VERSION']).toBe('2.0');
    expect(props['UID']).toBe('slot-1@wevolunteer.org');
    expect(props['DTSTART']).toBe('20260811T073000Z');
    expect(props['DTEND']).toBe('20260811T093000Z');
    expect(props['DTSTAMP']).toBe('20260730T120000Z');
  });

  it('opens and closes VEVENT inside VCALENDAR', () => {
    const { lines } = parse(buildShiftIcs(SHIFT));
    expect(lines.indexOf('BEGIN:VEVENT')).toBeGreaterThan(lines.indexOf('BEGIN:VCALENDAR'));
    expect(lines.indexOf('END:VEVENT')).toBeLessThan(lines.indexOf('END:VCALENDAR'));
  });
});

describe('ICS TEXT escaping (§3.3.11)', () => {
  it('escapes commas, which are otherwise value-list separators', () => {
    // The real seeded description contains commas; unescaped, the value is
    // truncated at the first one by a conformant parser.
    const ics = buildShiftIcs({ ...SHIFT, location: '12 Main St, Kendall Park, NJ' });
    const { props } = parse(ics);
    expect(props['LOCATION']).toBe('12 Main St\\, Kendall Park\\, NJ');
  });

  it('escapes semicolons and backslashes', () => {
    const { props } = parse(buildShiftIcs({ ...SHIFT, summary: 'A; B \\ C' }));
    expect(props['SUMMARY']).toBe('A\\; B \\\\ C');
  });

  it('encodes newlines as the \\n escape rather than breaking the line', () => {
    const { props } = parse(buildShiftIcs({ ...SHIFT, description: 'Line one\n\nLine two' }));
    expect(props['DESCRIPTION']).toBe('Line one\\n\\nLine two');
  });

  it('escapes in the order required so a backslash is not double-processed', () => {
    // If `,` were escaped before `\`, the inserted backslash would itself be
    // escaped and the value would be corrupt.
    expect(escapeText('a,b')).toBe('a\\,b');
    expect(escapeText('a\\b')).toBe('a\\\\b');
    expect(escapeText('a\\,b')).toBe('a\\\\\\,b');
  });

  it('survives a title containing every special character at once', () => {
    const nasty = 'Setup; teardown, "notes" \\ 100% — café 🎉\nsecond line';
    const { props } = parse(buildShiftIcs({ ...SHIFT, summary: nasty }));
    expect(props['SUMMARY']).not.toContain('\n');
    // Unescaping must round-trip back to the original.
    const unescaped = props['SUMMARY']
      .replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    expect(unescaped).toBe(nasty);
  });
});

describe('ICS line folding (§3.1)', () => {
  it('keeps every physical line within 75 octets', () => {
    const longDescription = 'Every shift must have an adult volunteer due to cooking and grilling. '
      + 'The remaining slots can be taken by either high school volunteers, or additional parents. '
      + 'We are requesting that each family signs up for at least one time slot. Thank you!';
    const ics = buildShiftIcs({ ...SHIFT, description: longDescription });
    expect(longestOctetLine(ics)).toBeLessThanOrEqual(75);
  });

  it('unfolds back to the original value', () => {
    const longDescription = 'x'.repeat(400);
    const { props } = parse(buildShiftIcs({ ...SHIFT, description: longDescription }));
    expect(props['DESCRIPTION']).toBe(longDescription);
  });

  it('continuation lines begin with a single space', () => {
    const ics = buildShiftIcs({ ...SHIFT, description: 'y'.repeat(300) });
    const folded = ics.split('\r\n').filter(l => l.startsWith(' '));
    expect(folded.length).toBeGreaterThan(0);
    // Exactly one space, then content — not two, which would become part of the value.
    folded.forEach(l => expect(l).toMatch(/^ \S/));
  });

  it('never splits a multi-byte character across a fold', () => {
    // Each emoji is 4 octets; folding on a byte boundary mid-sequence would
    // produce U+FFFD on unfold.
    const emoji = '🎉'.repeat(60);
    const { props } = parse(buildShiftIcs({ ...SHIFT, description: emoji }));
    expect(props['DESCRIPTION']).toBe(emoji);
    expect(props['DESCRIPTION']).not.toContain('�');
  });

  it('leaves a short line unfolded', () => {
    expect(foldLine('SUMMARY:Short')).toBe('SUMMARY:Short');
  });
});

describe('ICS dates', () => {
  it('formats as UTC basic format', () => {
    expect(formatIcsDate('2026-08-11T07:30:00.000Z')).toBe('20260811T073000Z');
  });

  it('normalises a non-UTC input to UTC', () => {
    expect(formatIcsDate('2026-08-11T07:30:00+02:00')).toBe('20260811T053000Z');
  });

  it('rejects an unparseable date rather than emitting "InvalidDate"', () => {
    expect(() => formatIcsDate('not-a-date')).toThrow(/Invalid date/);
  });
});
