import { describe, it, expect } from 'vitest';
import {
  detectKind, inspectFile, parseDate, extractFields, keepValidFields,
  hasUsableText, LIMITS, CertificateError,
} from './extract.js';

const TODAY = new Date('2026-08-15T12:00:00Z');
const fileOf = (bytes, { type = 'application/pdf', name = 'cert.pdf' } = {}) =>
  new File([new Uint8Array(bytes)], name, { type });

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];

describe('identifying a file by its bytes', () => {
  it('recognises the formats a certificate arrives in', () => {
    expect(detectKind(new Uint8Array(PDF))).toBe('pdf');
    expect(detectKind(new Uint8Array(PNG))).toBe('png');
    expect(detectKind(new Uint8Array(JPEG))).toBe('jpeg');
  });

  it('believes the bytes rather than the name or the type', async () => {
    /**
     * `file.type` is the browser repeating what the OS guessed from the
     * extension. A JPEG named `.pdf` must be treated as a JPEG, or the PDF
     * parser is handed something that is not a PDF.
     */
    const jpegNamedPdf = fileOf(JPEG, { type: 'application/pdf', name: 'certificate.pdf' });
    expect(await inspectFile(jpegNamedPdf)).toBe('jpeg');
  });

  it('refuses something that is neither', async () => {
    const zip = fileOf([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0], { name: 'cert.pdf' });
    await expect(inspectFile(zip)).rejects.toThrow(CertificateError);
    await expect(inspectFile(zip)).rejects.toThrow(/PDF or an image/i);
  });
});

describe('bounds', () => {
  it('refuses a file too large to be a certificate', async () => {
    /* Refused on the declared size, before a byte is read — the point is not
       to be parsing when the tab dies. */
    const huge = { size: LIMITS.maxBytes + 1, slice: () => { throw new Error('should not read'); } };
    await expect(inspectFile(huge)).rejects.toThrow(/larger than/i);
  });

  it('refuses an empty file', async () => {
    await expect(inspectFile(fileOf([]))).rejects.toThrow(/empty/i);
  });

  it('refuses nothing at all', async () => {
    await expect(inspectFile(null)).rejects.toThrow(/choose a file/i);
  });
});

describe('reading dates', () => {
  it('reads the forms certificates actually use', () => {
    const cases = [
      ['2026-08-10', '2026-08-10'],
      ['10 August 2026', '2026-08-10'],
      ['10 Aug 2026', '2026-08-10'],
      ['August 10, 2026', '2026-08-10'],
      ['Aug 10th, 2026', '2026-08-10'],
      ['25/07/2026', '2026-07-25'],
      ['07.25.2026', '2026-07-25'],
    ];
    for (const [input, expected] of cases) {
      expect(parseDate(input, { today: TODAY }), input).toBe(expected);
    }
  });

  it('refuses to guess an ambiguous numeric date', () => {
    /**
     * `03/04/2026` is the 3rd of April or the 4th of March depending on where
     * the certificate was printed, and nothing in the document says which. An
     * empty field a student fills is better than a wrong date that looks
     * deliberate in their service record.
     */
    expect(parseDate('03/04/2026', { today: TODAY })).toBeNull();
  });

  it('refuses a date that does not exist', () => {
    expect(parseDate('31 February 2026', { today: TODAY })).toBeNull();
    expect(parseDate('2026-02-31', { today: TODAY })).toBeNull();
  });

  it('refuses a future date, because the server will', () => {
    /* Offering one would produce an error only after the student had read it
       as correct. */
    expect(parseDate('2027-01-01', { today: TODAY })).toBeNull();
    expect(parseDate('2026-08-15', { today: TODAY })).toBe('2026-08-15');
  });

  it('returns null for anything it cannot read', () => {
    expect(parseDate('sometime last spring', { today: TODAY })).toBeNull();
    expect(parseDate('', { today: TODAY })).toBeNull();
    expect(parseDate(null, { today: TODAY })).toBeNull();
  });
});

describe('reading a formulaic certificate', () => {
  const TEXT = `
    Certificate of Appreciation
    Presented by: Environmental Club
    This certifies that Leo Chen completed 4 hours of volunteer service
    for their service at Community Cleanup
    Date: 10 August 2026
  `;

  it('finds the fields without a model', () => {
    /* The case this exists for. A digitally issued certificate states all four
       plainly, and patterns read them exactly and instantly. */
    const { fields } = extractFields(TEXT, { today: TODAY });

    expect(fields.hours).toBe(4);
    expect(fields.occurredOn).toBe('2026-08-10');
    expect(fields.organizationName).toBe('Environmental Club');
    expect(fields.activityName).toBe('Community Cleanup');
  });

  it('records where each field came from', () => {
    const { sources } = extractFields(TEXT, { today: TODAY });
    expect(sources.hours).toBe('document');
  });

  it('reads decimal hours', () => {
    expect(extractFields('completed 2.5 hours of service', { today: TODAY }).fields.hours).toBe(2.5);
    expect(extractFields('Hours: 3.25', { today: TODAY }).fields.hours).toBe(3.25);
  });

  it('finds each field independently', () => {
    /* A partial read still saves most of the typing, so one missing field must
       not cost the others. */
    const { fields } = extractFields('Awarded 6 hrs for helping out.', { today: TODAY });
    expect(fields.hours).toBe(6);
    expect(fields.occurredOn).toBeUndefined();
  });

  it('does not run a value on when the text arrives without line breaks', () => {
    /**
     * The defect a real PDF produced. `getTextContent()` returns positioned
     * fragments, and before line ends were reconstructed the whole page came
     * back as one line — so the pattern for "Presented by:" ran past its value
     * and returned "Environmental Club This certifies that Leo Chen completed
     * 4 h".
     *
     * Line reconstruction is the fix; this pins the second half of it, so that
     * a page whose fragments arrive unbroken still degrades to a usable value
     * rather than a plausible wrong one. Wrong in this direction is the worst
     * kind: it reads as a successful reading of the document.
     */
    const oneLine = 'Certificate of Appreciation Presented by: Environmental Club '
      + 'This certifies that Leo Chen completed 4 hours of volunteer service '
      + 'for their service at Community Cleanup Date: 10 August 2026';

    const { fields } = extractFields(oneLine, { today: TODAY });

    expect(fields.organizationName).toBe('Environmental Club');
    expect(fields.activityName).toBe('Community Cleanup');
    /* The other two are unambiguous in shape and were never affected. */
    expect(fields.hours).toBe(4);
    expect(fields.occurredOn).toBe('2026-08-10');
  });

  it('finds nothing in text that says nothing', () => {
    const { fields } = extractFields('Thank you for your continued support.', { today: TODAY });
    expect(fields).toEqual({});
  });
});

describe('deciding whether a text layer is worth using', () => {
  it('accepts a real certificate', () => {
    expect(hasUsableText('Certificate of Appreciation. 4 hours of volunteer service completed.')).toBe(true);
  });

  it('rejects the stray glyphs a scan produces', () => {
    /* A scanned page yields a handful of characters rather than nothing, so
       presence alone cannot be the test. */
    expect(hasUsableText('  \n  f  \n ')).toBe(false);
    expect(hasUsableText('')).toBe(false);
    expect(hasUsableText(null)).toBe(false);
  });
});

describe('validating what was extracted', () => {
  it('keeps fields the server would accept', () => {
    const { fields, rejected } = keepValidFields({
      organizationName: 'Environmental Club',
      activityName: 'Community Cleanup',
      occurredOn: '2026-08-10',
      hours: 4,
    });
    expect(fields).toEqual({
      organizationName: 'Environmental Club',
      activityName: 'Community Cleanup',
      occurredOn: '2026-08-10',
      hours: 4,
    });
    expect(rejected).toEqual([]);
  });

  it('drops an hours figure beyond what one entry may hold', () => {
    /**
     * The ceiling is the server's, imported rather than restated. A model
     * asked for a number will sometimes return a large one, and showing it
     * would mean a student submits and only then learns it is impossible.
     */
    const { fields, rejected } = keepValidFields({ hours: 999999 });
    expect(fields.hours).toBeUndefined();
    expect(rejected).toContain('hours');
  });

  it('drops a date the model wrote in prose', () => {
    /* Measured against the real model: asked for a date, a 135M model returned
       "10 August 2026". Schema-valid as a string, and not what the form takes. */
    const { fields, rejected } = keepValidFields({ occurredOn: '10 August 2026' });
    expect(fields.occurredOn).toBeUndefined();
    expect(rejected).toContain('occurredOn');
  });

  it('drops a future date', () => {
    const { rejected } = keepValidFields({ occurredOn: '2099-01-01' });
    expect(rejected).toContain('occurredOn');
  });

  it('drops an over-long organization name rather than truncating it', () => {
    const { rejected } = keepValidFields({ organizationName: 'x'.repeat(500) });
    expect(rejected).toContain('organizationName');
  });

  it('keeps the good fields when a bad one is present', () => {
    /* One unusable value must not discard a correct reading of the others. */
    const { fields, rejected } = keepValidFields({ hours: 4, occurredOn: 'last Tuesday' });
    expect(fields.hours).toBe(4);
    expect(rejected).toEqual(['occurredOn']);
  });

  it('ignores empty values without calling them rejected', () => {
    const { fields, rejected } = keepValidFields({ hours: 4, activityName: '', organizationName: null });
    expect(fields).toEqual({ hours: 4 });
    expect(rejected).toEqual([]);
  });
});
