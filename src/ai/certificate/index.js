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
 * ── Images are not read yet ──
 *
 * A photograph of a certificate needs optical character recognition, which is
 * another dependency and, on the research available, the step most likely to
 * return confident nonsense for the one field that matters most — the hours.
 * Rather than ship a guess, an image is accepted, identified, and reported as
 * something to type in manually. That is a worse feature than reading it and a
 * better one than reading it wrong.
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

  if (kind !== 'pdf') {
    return {
      fields: {},
      sources: {},
      text: '',
      notes: [
        'That looks like a photo. Reading text out of an image is not supported yet, '
        + 'so please type the details in below.',
      ],
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const text = await withTimeout(
    extractPdfText(bytes),
    LIMITS.timeoutMs,
    'That PDF took too long to read. Please type the details in below.',
  );

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

  const missing = ['organizationName', 'activityName', 'occurredOn', 'hours']
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

  if (Object.keys(valid).length === 0 && notes.length === 0) {
    notes.push("We couldn't confidently read this certificate. Please type the details in below.");
  }

  return { fields: valid, sources, notes, text };
}

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
