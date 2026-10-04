/**
 * Turning a certificate file into a draft hours entry.
 *
 * Four passes, each cheaper than the next and each optional:
 *
 *   bytes → PDF text layer → patterns → model (schema-constrained) → validate
 *
 * A digitally issued PDF usually finishes at the patterns and never involves a
 * model at all. The model exists for the ones that do not fit the formula.
 *
 * ── Every field is validated before it is shown ──
 *
 * Whether a pattern or the model produced a value, it goes through the server's
 * own rules before a student sees it. This is not defensive habit: measured
 * against the real 135M model, asked for a date under a schema requiring a
 * string, it returned "10 August 2026" — schema-valid, and not what the form
 * accepts. Showing it would have meant a student read it as correct and learned
 * otherwise on submit.
 *
 * ── A photo is read for everything except the hours ──
 *
 * A photograph needs optical character recognition, the step most likely to
 * return confident nonsense for the one field that matters most: the hours.
 * Photos were therefore not read at all. The owner ruled on 2026-10-04
 * (ruling 20) to read them and keep the objection: organization, activity and
 * date come from the photo (`ocr.js`, on the device), and the hours are never
 * filled from one, by the patterns or by the model. The student types them.
 * A scan inside a PDF is still not read; rasterising PDF pages is a path this
 * module deliberately never takes (see `extractPdfText`).
 */

import {
  inspectFile, extractPdfText, extractFields, keepValidFields, hasUsableText, LIMITS,
  CertificateError,
} from './extract.js';
import { AIStatus } from '../runtime/types.js';
import { isAbort } from '../runtime/types.js';
import { CERTIFICATE_PROMPT, asDataBlock } from '../prompts/tasks.js';

/**
 * The shape the model is constrained to.
 *
 * Compiled to a grammar and enforced at the sampler, so the reply parses. It
 * describes only what the form takes — a model given room to volunteer extra
 * fields will use it.
 *
 * `occurredOn` is described rather than merely typed, because the schema can
 * only require a string and the form requires a particular one. The description
 * improves the odds; `keepValidFields` is what guarantees the outcome.
 */
export const EXTRACTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    organizationName: { type: 'string', description: 'Who ran the volunteering' },
    activityName: { type: 'string', description: 'What the volunteer did' },
    occurredOn: { type: 'string', description: 'The date, formatted YYYY-MM-DD' },
    hours: { type: 'number', description: 'Hours volunteered, at most 24' },
  },
  required: ['organizationName', 'activityName', 'occurredOn', 'hours'],
  additionalProperties: false,
});


/**
 * Read a certificate.
 *
 * Returns `{ fields, sources, notes, text }`:
 *   fields   validated values suitable for the form, possibly incomplete
 *   sources  per field, 'document' or 'ai' — what the UI marks as AI-extracted
 *   notes    things worth telling the person, already phrased for them
 *
 * Never throws for a file it simply could not read — that is a result, not an
 * error. It throws only for a file that should not have been offered.
 */
export async function readCertificate(file, { runtime = null, signal, today = new Date() } = {}) {
  const kind = await inspectFile(file);
  const notes = [];

  const isPhoto = kind !== 'pdf';
  let text;

  if (isPhoto) {
    try {
      /* Loaded here and only here, so a PDF never downloads the recogniser. */
      const { recognizeText } = await import('./ocr.js');
      text = await recognizeText(file, { signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      return {
        fields: {},
        sources: {},
        text: '',
        notes: ['That photo could not be read on this device. Please type the details in below.'],
      };
    }
    notes.push(PHOTO_HOURS_NOTE);
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    text = await withTimeout(
      extractPdfText(bytes),
      LIMITS.timeoutMs,
      'That PDF took too long to read. Please type the details in below.',
    );
  }

  if (isPhoto && !hasUsableText(text)) {
    return {
      fields: {},
      sources: {},
      text: '',
      notes: ['No text could be read from that photo. Please type the details in below.'],
    };
  }

  if (!hasUsableText(text)) {
    /* A scanned page inside a PDF wrapper. The text layer is absent or is a
       few stray glyphs, and reading it would need the same OCR an image does. */
    return {
      fields: {},
      sources: {},
      text: '',
      notes: [
        'That PDF looks like a scan rather than text, so there was nothing to read. '
        + 'Please type the details in below.',
      ],
    };
  }

  const pattern = extractFields(text, { today });
  let fields = { ...pattern.fields };
  const sources = { ...pattern.sources };

  /* Ruling 20: a photo never supplies the hours, from the patterns or from the
     model. Every other field it supplies is marked as read from a photo. */
  if (isPhoto) {
    delete fields.hours;
    delete sources.hours;
    for (const key of Object.keys(sources)) sources[key] = 'photo';
  }

  const missing = (isPhoto ? PHOTO_FIELDS : ALL_FIELDS)
    .filter(key => fields[key] === undefined);

  /* The model runs only for what the patterns did not find, and only when one
     is loaded. Everything above works with AI switched off. */
  if (missing.length > 0 && runtime && runtime.status === AIStatus.READY) {
    try {
      const reply = await runtime.generate(
        [{ role: 'user', content: `${CERTIFICATE_PROMPT}\n\n${asDataBlock('CERTIFICATE TEXT', text)}` }],
        { schema: EXTRACTION_SCHEMA, signal, maxTokens: 200 },
      );

      const parsed = safeParse(reply);
      /* `missing` never names the hours for a photo, so a model that returns
         them anyway contributes nothing there. */
      for (const key of missing) {
        const value = parsed?.[key];
        if (value === undefined || value === '' || value === 0) continue;
        fields[key] = value;
        sources[key] = 'ai';
      }
    } catch (err) {
      /* Cancelling or failing here costs the model's contribution, not the
         pattern results already in hand. */
      if (!isAbort(err)) notes.push('The assistant could not read the rest of it.');
    }
  }

  const { fields: valid, rejected } = keepValidFields(fields);
  for (const key of rejected) delete sources[key];

  if (rejected.includes('occurredOn')) {
    notes.push('The date could not be read reliably, so it has been left blank.');
  }
  if (rejected.includes('hours')) {
    notes.push('The hours could not be read reliably, so they have been left blank.');
  }

  if (Object.keys(valid).length === 0 && notes.every(n => n === PHOTO_HOURS_NOTE)) {
    notes.push("We couldn't confidently read this certificate. Please type the details in below.");
  }

  /* `fillable` is what this read could ever supply, so a caller deciding
     whether to load a model for the gaps does not count the hours of a photo
     as a gap. */
  return { fields: valid, sources, notes, text, fillable: isPhoto ? [...PHOTO_FIELDS] : [...ALL_FIELDS] };
}

const ALL_FIELDS = Object.freeze(['organizationName', 'activityName', 'occurredOn', 'hours']);

/** What a photo may fill. Never `hours`: see the note at the top. */
const PHOTO_FIELDS = Object.freeze(['organizationName', 'activityName', 'occurredOn']);

const PHOTO_HOURS_NOTE = 'Hours are never read from a photo. Please type them in yourself: '
  + 'it is the number a photo is most often misread on, and it goes on your record.';

function safeParse(reply) {
  try {
    return JSON.parse(String(reply || '').trim());
  } catch {
    /* The grammar makes this unlikely rather than impossible, and an
       unparseable reply is simply no contribution. */
    return null;
  }
}

/**
 * Bound a parse in time as well as in size.
 *
 * A small file can still be shaped to take a very long time to parse, and a
 * page that appears to have frozen is indistinguishable from one that has.
 */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new CertificateError(message, { code: 'timeout' })),
      ms,
    )),
  ]);
}
