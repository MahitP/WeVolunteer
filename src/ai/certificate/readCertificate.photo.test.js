import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reading a photo of a certificate (ruling 20, 2026-10-04).
 *
 * The owner asked for photos to be read (P2-31). The code had declined, on the
 * grounds that OCR is most likely to return confident nonsense for the one
 * field that matters most: the hours. The ruling keeps that reasoning and
 * reads everything else: organization, activity and date come from the photo,
 * and the hours are never filled from one. The student types them, so a
 * misread can never become hours on a record.
 *
 * The recogniser itself (Tesseract, in a worker) is replaced here; what is
 * exercised is everything around it.
 */

const recognizeText = vi.fn();
vi.mock('./ocr.js', () => ({ recognizeText: (...args) => recognizeText(...args) }));

const extractPdfText = vi.fn();
vi.mock('./extract.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, extractPdfText: (...args) => extractPdfText(...args) };
});

const { readCertificate } = await import('./index.js');
const { MockRuntime } = await import('../runtime/MockRuntime.js');

const TODAY = new Date('2026-08-15T12:00:00Z');
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const photo = (bytes = JPEG, name = 'cert.jpg') => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });

const PHOTOGRAPHED = `Certificate of Appreciation
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
  recognizeText.mockResolvedValue(PHOTOGRAPHED);
});

describe('a photo of a certificate', () => {
  it('fills the organization, activity and date, marked as read from a photo', async () => {
    const res = await readCertificate(photo(), { runtime: null, today: TODAY });
    expect(recognizeText).toHaveBeenCalledTimes(1);
    expect(res.fields).toEqual({
      organizationName: 'Environmental Club',
      activityName: 'Community Cleanup',
      occurredOn: '2026-08-10',
    });
    expect(Object.values(res.sources).every(s => s === 'photo')).toBe(true);
  });

  it('never fills the hours, even when the photo shows them, and says why', async () => {
    const res = await readCertificate(photo(PNG, 'cert.png'), { runtime: null, today: TODAY });
    expect(res.fields.hours).toBeUndefined();
    expect(res.sources.hours).toBeUndefined();
    expect(res.notes.join(' ')).toMatch(/hours/i);
    expect(res.notes.join(' ')).toMatch(/type/i);
  });

  it('asks the model only for what is missing, and never for the hours', async () => {
    recognizeText.mockResolvedValue('Thank you for helping out. Riverside Shelter, August 2026.');
    const rt = await readyRuntime(JSON.stringify({
      organizationName: 'Riverside Shelter', activityName: 'Morning shift', occurredOn: '2026-08-10', hours: 9,
    }));
    const res = await readCertificate(photo(), { runtime: rt, today: TODAY });
    expect(res.fields.organizationName).toBe('Riverside Shelter');
    expect(res.sources.organizationName).toBe('ai');
    expect(res.fields.hours).toBeUndefined();
  });

  it('says so plainly when the photo yields no usable text', async () => {
    recognizeText.mockResolvedValue('  ~ . ');
    const res = await readCertificate(photo(), { runtime: null, today: TODAY });
    expect(res.fields).toEqual({});
    expect(res.notes.join(' ')).toMatch(/type the details in/i);
  });

  it('keeps going when the recogniser fails, with a note rather than an error', async () => {
    recognizeText.mockRejectedValue(new Error('worker died'));
    const res = await readCertificate(photo(), { runtime: null, today: TODAY });
    expect(res.fields).toEqual({});
    expect(res.notes.join(' ')).toMatch(/photo/i);
    expect(res.notes.join(' ')).toMatch(/type the details in/i);
  });

  it('leaves a PDF to its text layer, and its hours as they were', async () => {
    extractPdfText.mockResolvedValue(PHOTOGRAPHED);
    const res = await readCertificate(new File([new Uint8Array(PDF)], 'c.pdf'), { runtime: null, today: TODAY });
    expect(recognizeText).not.toHaveBeenCalled();
    expect(res.fields.hours).toBe(4);
  });
});

describe('the recogniser is self-hosted and loaded only for a photo', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/ai/certificate/ocr.js'), 'utf8');
  const index = fs.readFileSync(path.join(process.cwd(), 'src/ai/certificate/index.js'), 'utf8');

  it('gives Tesseract every file from this origin, so nothing comes from a CDN', () => {
    expect(src).toMatch(/workerPath:/);
    expect(src).toMatch(/corePath:/);
    expect(src).toMatch(/langPath: new URL\(OCR_LANGUAGE_PATH/);
    const config = fs.readFileSync(path.join(process.cwd(), 'vite.config.js'), 'utf8');
    expect(config).toMatch(/ocrLanguageData\(localAiFlag\(mode\) === 'true'\)/);
    expect(src).not.toMatch(/https?:\/\//);
  });

  it('runs the worker from a file, not a blob, and caches nothing of its own', () => {
    expect(src).toMatch(/workerBlobURL: false/);
    expect(src).toMatch(/cacheMethod: 'none'/);
  });

  it('bounds starting the worker as well as the read, since a failed start never settles', () => {
    expect(src).toMatch(/errorHandler:/);
    expect(src).toMatch(/Promise\.race\(\[read\(\), abandon\]\)/);
  });

  it('is imported on demand, so a PDF never downloads it', () => {
    expect(src).toMatch(/await import\('tesseract\.js'\)/);
    expect(src).not.toMatch(/^import .* from 'tesseract\.js';/m);
    expect(index).toMatch(/await import\('\.\/ocr\.js'\)/);
    expect(index).not.toMatch(/^import .* from '\.\/ocr\.js';/m);
  });
});
