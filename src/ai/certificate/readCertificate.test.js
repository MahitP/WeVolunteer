import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The whole read, with the PDF parser replaced.
 *
 * `pdfjs-dist` needs a worker and real PDF bytes, neither of which belongs in
 * a unit test — so the text-layer step is stubbed and everything after it is
 * exercised for real: the patterns, the model, the validation, and the
 * decisions about what to tell somebody when a pass comes back empty.
 */

const extractPdfText = vi.fn();

vi.mock('./extract.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, extractPdfText: (...args) => extractPdfText(...args) };
});

const { readCertificate } = await import('./index.js');
const { MockRuntime } = await import('../runtime/MockRuntime.js');

const TODAY = new Date('2026-08-15T12:00:00Z');
const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];

const fileOf = bytes => new File([new Uint8Array(bytes)], 'cert.pdf', { type: 'application/pdf' });

const FORMULAIC = `Certificate of Appreciation
Presented by: Environmental Club
This certifies that Leo Chen completed 4 hours of volunteer service
for their service at Community Cleanup
Date: 10 August 2026`;

async function readyRuntime(...responses) {
  const rt = new MockRuntime({ responses });
  await rt.load({ id: 'm', version: 1, bytes: 10 });
  return rt;
}

beforeEach(() => {
  vi.clearAllMocks();
  extractPdfText.mockResolvedValue(FORMULAIC);
});

describe('a certificate the patterns can read', () => {
  it('fills every field without consulting a model', async () => {
    /**
     * The common case for a digitally issued certificate, and the reason this
     * feature is worth having with AI switched off entirely.
     */
    const rt = await readyRuntime('{"organizationName":"WRONG"}');
    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });

    expect(res.fields).toEqual({
      organizationName: 'Environmental Club',
      activityName: 'Community Cleanup',
      occurredOn: '2026-08-10',
      hours: 4,
    });
    expect(rt.calls).toHaveLength(0);
    expect(Object.values(res.sources)).toEqual(['hours', 'occurredOn', 'organizationName', 'activityName'].map(() => 'document'));
  });

  it('works with no model at all', async () => {
    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: null, today: TODAY });
    expect(res.fields.hours).toBe(4);
  });
});

describe('a certificate that needs the model', () => {
  const FREEFORM = `Thank you Leo for giving your time so generously to us
    over the course of the morning. It made a real difference.
    Riverside Shelter, on the tenth of August, two thousand and twenty six.`;

  it('asks only for what the patterns missed, and marks it', async () => {
    extractPdfText.mockResolvedValue(FREEFORM);
    const rt = await readyRuntime(JSON.stringify({
      organizationName: 'Riverside Shelter',
      activityName: 'Morning shift',
      occurredOn: '2026-08-10',
      hours: 3,
    }));

    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });

    expect(res.fields.organizationName).toBe('Riverside Shelter');
    expect(res.sources.organizationName).toBe('ai');
    /* The schema went with the request — that is what makes the reply parse. */
    expect(rt.calls[0].schema.properties.hours.type).toBe('number');
  });

  it('sends the certificate text as delimited data', async () => {
    extractPdfText.mockResolvedValue(FREEFORM);
    const rt = await readyRuntime('{}');
    await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });

    expect(rt.calls[0].messages[0].content).toContain('CERTIFICATE TEXT:');
    expect(rt.calls[0].messages[0].content).toContain('---');
  });

  it('drops a date the model wrote in prose', async () => {
    /**
     * Measured against the real 135M model: given a schema requiring a string,
     * it returned "10 August 2026". Schema-valid, and not what the form takes.
     * The grammar guarantees the shape; only validation guarantees the value.
     */
    extractPdfText.mockResolvedValue(FREEFORM);
    const rt = await readyRuntime(JSON.stringify({
      organizationName: 'Riverside Shelter',
      activityName: 'Morning shift',
      occurredOn: '10 August 2026',
      hours: 3,
    }));

    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });

    expect(res.fields.occurredOn).toBeUndefined();
    expect(res.sources.occurredOn).toBeUndefined();
    expect(res.notes.join(' ')).toMatch(/date could not be read/i);
    /* The fields it did get right survive. */
    expect(res.fields.organizationName).toBe('Riverside Shelter');
  });

  it('drops an impossible hours figure', async () => {
    extractPdfText.mockResolvedValue(FREEFORM);
    const rt = await readyRuntime(JSON.stringify({
      organizationName: 'Riverside Shelter', activityName: 'Shift',
      occurredOn: '2026-08-10', hours: 999,
    }));

    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });
    expect(res.fields.hours).toBeUndefined();
    expect(res.notes.join(' ')).toMatch(/hours could not be read/i);
  });

  it('keeps the pattern results when the model fails', async () => {
    const rt = await readyRuntime();
    rt.generate = vi.fn().mockRejectedValue(new Error('worker died'));
    extractPdfText.mockResolvedValue(
      'Certificate of Appreciation. Awarded 6 hours for helping out at the shelter.',
    );

    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });
    expect(res.fields.hours).toBe(6);
  });

  it('survives an unparseable reply', async () => {
    extractPdfText.mockResolvedValue(
      'Certificate of Appreciation. Awarded 6 hours for helping out at the shelter.',
    );
    const rt = await readyRuntime('not json at all');

    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: rt, today: TODAY });
    expect(res.fields.hours).toBe(6);
  });
});

describe('files it cannot read', () => {
  it('says so plainly for a photo, rather than guessing', async () => {
    /* Optical character recognition is not in yet, and reading an image wrong
       is worse than not reading it. */
    const res = await readCertificate(fileOf(JPEG_BYTES), { runtime: null, today: TODAY });
    expect(res.fields).toEqual({});
    expect(res.notes.join(' ')).toMatch(/photo/i);
    expect(res.notes.join(' ')).toMatch(/type the details in/i);
  });

  it('recognises a scan wrapped in a PDF', async () => {
    extractPdfText.mockResolvedValue('  \n f \n ');
    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: null, today: TODAY });

    expect(res.fields).toEqual({});
    expect(res.notes.join(' ')).toMatch(/scan rather than text/i);
  });

  it('admits when it read the text but found nothing in it', async () => {
    extractPdfText.mockResolvedValue('Thank you for your continued support of our work here.');
    const res = await readCertificate(fileOf(PDF_BYTES), { runtime: null, today: TODAY });

    expect(res.fields).toEqual({});
    expect(res.notes.join(' ')).toMatch(/couldn't confidently read/i);
  });

  it('refuses a file that is not a document at all', async () => {
    const zip = new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])], 'x.pdf');
    await expect(readCertificate(zip, { runtime: null })).rejects.toThrow(/PDF or an image/i);
  });
});

describe('nothing leaves the device', () => {
  it('never calls fetch', async () => {
    /**
     * The property the privacy claim rests on. There is no upload endpoint for
     * this and no server involvement — the file is read, parsed and discarded.
     */
    const spy = vi.spyOn(globalThis, 'fetch');
    await readCertificate(fileOf(PDF_BYTES), { runtime: null, today: TODAY });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
