/**
 * Reading a volunteer certificate, on the device, without uploading it.
 *
 * ── Nothing is sent anywhere ──
 *
 * The file is read into memory, parsed, and discarded. There is no upload
 * endpoint for this and no server involvement at all, which is both a privacy
 * property and the reason this feature needed no new route, no multer path and
 * no new size limit on the API.
 *
 * ── Order of attempts, cheapest first ──
 *
 *   1. Magic bytes decide what the file actually is.
 *   2. A PDF's text layer, if it has one — free, exact, no model.
 *   3. Deterministic patterns over that text — free, and right often enough
 *      that most certificates never need a model.
 *   4. The model, under a grammar-constrained schema, for whatever is left.
 *
 * Steps 1 to 3 work with AI switched off entirely. That matters: the useful
 * part of this feature for a digitally issued certificate is not the model, it
 * is having read the file at all.
 *
 * ── Everything found here is a draft ──
 *
 * Nothing extracted is ever submitted. It fills a form a student reads, edits
 * and sends themselves. These hours end up in their service record, so a
 * machine's reading of a document is a suggestion and a person's confirmation
 * is the decision.
 */

import { validateExternalHours } from '../../externalHoursRules.js';

/** Bounds, chosen so a hostile or accidental file fails fast rather than deep. */
export const LIMITS = Object.freeze({
  /* A scanned certificate is well under this. The number exists so a 500 MB
     file is refused before it is read, not while the tab is dying. */
  maxBytes: 15 * 1024 * 1024,
  /* Certificates are one page. A few are two. Nothing legitimate is twenty,
     and parsing is where a malicious PDF would spend its effort. */
  maxPages: 5,
  /* Enough text for any certificate, short of a model's context window. */
  maxCharacters: 20000,
  /* Parsing is bounded in time as well as size: a small file can still be
     shaped to take a very long time to parse. */
  timeoutMs: 20000,
});

/** What a file claims to be is irrelevant; what it starts with is not. */
const SIGNATURES = [
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },                    // %PDF
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { kind: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
];

/**
 * Identify a file by its leading bytes.
 *
 * `file.type` is the browser repeating what the operating system guessed from
 * the extension — it is the client's claim, exactly as `profilePictureRoutes`
 * says of an upload's mimetype, and it is trivially wrong. A `.pdf` that is
 * actually a JPEG should be treated as a JPEG, and something that is neither
 * should be refused before any parser sees it.
 */
export function detectKind(bytes) {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => bytes[i] === b)) return sig.kind;
  }
  return null;
}

/** A refusal a person can act on, distinct from an unexpected failure. */
export class CertificateError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'CertificateError';
    this.code = code;
  }
}

/**
 * Check a file before opening it.
 *
 * Returns the detected kind. Throws a CertificateError whose message is
 * already fit to show, because every rejection here is something the person
 * chose the file for and can fix by choosing another.
 */
export async function inspectFile(file) {
  if (!file) throw new CertificateError('Choose a file first.', { code: 'no_file' });

  if (file.size > LIMITS.maxBytes) {
    const mb = Math.round(LIMITS.maxBytes / (1024 * 1024));
    throw new CertificateError(
      `That file is larger than ${mb} MB. Try a smaller scan or a screenshot.`,
      { code: 'too_large' },
    );
  }
  if (file.size === 0) {
    throw new CertificateError('That file is empty.', { code: 'empty' });
  }

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const kind = detectKind(head);
  if (!kind) {
    throw new CertificateError(
      'That does not look like a PDF or an image. Certificates can be PDF, JPG or PNG.',
      { code: 'unsupported_type' },
    );
  }
  return kind;
}

/**
 * Pull the text layer out of a PDF.
 *
 * ── Why the annotation layer is never touched ──
 *
 * A PDF can carry JavaScript, and it runs when a viewer builds the annotation
 * layer that hosts form fields and link actions. This never constructs one: it
 * opens the document, asks each page for its text content, and stops. The
 * scripting is unreachable because the machinery that would reach it is never
 * built, which is a stronger position than switching a flag off — and `pdf.js`
 * v6 removed `isEvalSupported`, so the flag people remember no longer exists.
 *
 * `pdfjs-dist` is imported dynamically, so a build with the feature off does
 * not carry it. Note it declares an optional dependency on `@napi-rs/canvas`,
 * a set of native binaries for rendering under Node — unused here, since
 * nothing in this path rasterises anything.
 */
export async function extractPdfText(bytes, { maxPages = LIMITS.maxPages } = {}) {
  const pdfjs = await import('pdfjs-dist');

  /* The worker is bundled as an asset and served from our own origin rather
     than from a CDN, for the same reason the model wasm is. */
  const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const task = pdfjs.getDocument({
    data: bytes,
    /* No external fetches while parsing, for fonts or anything else. A
       document must not be able to make the browser call out. */
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch {
    throw new CertificateError(
      "That PDF could not be opened. It may be damaged or password protected.",
      { code: 'unreadable_pdf' },
    );
  }

  try {
    const pages = Math.min(doc.numPages, maxPages);
    let text = '';
    for (let n = 1; n <= pages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      /**
       * Line breaks are reconstructed from the items, not assumed.
       *
       * `getTextContent()` returns positioned fragments, and joining them with
       * spaces collapses the whole page into one line. That is not cosmetic:
       * the field patterns are anchored to line ends, so on a real certificate
       * "Presented by:" ran past its value into the next sentence and the
       * organization came back as sixty characters of the paragraph after it.
       *
       * `hasEOL` is what pdf.js sets on the fragment that ends a line. Items
       * without it fall back to a space, so a viewer that stops providing the
       * flag degrades to the old behaviour rather than losing the text.
       */
      text += content.items
        .map(i => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : ''))
        .join('') + '\n';
      page.cleanup();
      if (text.length > LIMITS.maxCharacters) break;
    }
    return text.slice(0, LIMITS.maxCharacters);
  } finally {
    /**
     * Released via the LOADING TASK, not the document.
     *
     * `destroy()` lives on `PDFDocumentLoadingTask` and is what aborts
     * outstanding requests and tears down the worker. `PDFDocumentProxy` has
     * `cleanup()`, which only frees per-page resources — and no `destroy()` at
     * all, so calling it there throws. That threw on the first real PDF and on
     * no test, because the parser is stubbed in unit tests.
     */
    await task.destroy();
  }
}

/** True when a text layer yielded enough to be worth reading. */
export function hasUsableText(text) {
  /* A scanned page often yields a handful of stray glyphs rather than nothing,
     so presence alone is not the test. */
  return typeof text === 'string' && text.replace(/\s+/g, ' ').trim().length >= 40;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Turn whatever a certificate calls a date into `YYYY-MM-DD`.
 *
 * Returns null rather than guessing. An unparseable date left empty is a field
 * a student fills in; an incorrectly parsed one is a wrong date in their
 * service record that looks deliberate.
 *
 * Ambiguous all-numeric forms are read day-first only when the first number
 * cannot be a month. `03/04/2026` is genuinely ambiguous and is left to the
 * person.
 */
export function parseDate(raw, { today = new Date() } = {}) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return isoOrNull(+iso[1], +iso[2], +iso[3], today);

  // 10 August 2026 / 10 Aug 2026 / August 10, 2026
  const dmy = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (dmy && MONTHS[dmy[2].slice(0, 3).toLowerCase()]) {
    return isoOrNull(+dmy[3], MONTHS[dmy[2].slice(0, 3).toLowerCase()], +dmy[1], today);
  }
  const mdy = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (mdy && MONTHS[mdy[1].slice(0, 3).toLowerCase()]) {
    return isoOrNull(+mdy[3], MONTHS[mdy[1].slice(0, 3).toLowerCase()], +mdy[2], today);
  }

  const numeric = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (numeric) {
    const a = +numeric[1];
    const b = +numeric[2];
    /* Only resolved when it cannot be read both ways. */
    if (a > 12 && b <= 12) return isoOrNull(+numeric[3], b, a, today);
    if (b > 12 && a <= 12) return isoOrNull(+numeric[3], a, b, today);
    return null;
  }

  return null;
}

function isoOrNull(year, month, day, today) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  /* Round-tripped, so 31 February is refused rather than rolled forward. */
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== day || d.getUTCMonth() + 1 !== month) {
    return null;
  }
  /* The server refuses a future date, so offering one would only produce an
     error after the student had read it as correct. */
  if (iso > today.toISOString().slice(0, 10)) return null;
  return iso;
}

/**
 * Read the fields a certificate usually states plainly.
 *
 * Certificates are formulaic — "in recognition of 4 hours of service", "Date:
 * 10 August 2026" — and patterns handle the formulaic case exactly, instantly,
 * and with no model. What is left over is what the model is for.
 *
 * Every field is independent: finding hours does not depend on having found a
 * date, so a partial read still saves a student most of the typing.
 */
export function extractFields(text, { today = new Date() } = {}) {
  const raw = String(text || '');
  const flat = raw.replace(/\s+/g, ' ').trim();

  /**
   * Names are read per line; numbers are read across the whole text.
   *
   * The difference matters. "Presented by: Environmental Club" is a line, and
   * the value ends where the line does. Reading it out of the flattened text
   * instead let the pattern run straight through the line break and return
   * "Environmental Club This certifies that Leo Chen completed 4 h" — a
   * plausible-looking value that is wrong, which is the worst kind for a field
   * a student is being asked to confirm.
   *
   * Hours and dates have their own unambiguous shapes and can be found
   * anywhere, so those still scan the flattened text.
   */
  const lines = raw.split(/[\r\n]+/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const found = {};
  const sources = {};

  const hours = flat.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:hours?|hrs?\b)/i)
    || flat.match(/\b(?:hours?|hrs?)\s*[:-]?\s*(\d{1,2}(?:\.\d{1,2})?)\b/i);
  if (hours) {
    const value = Number(hours[1]);
    if (Number.isFinite(value) && value > 0) { found.hours = value; sources.hours = 'document'; }
  }

  const labelledDate = flat.match(/\b(?:date|on|completed(?:\s+on)?)\s*[:-]?\s*([A-Za-z0-9 ,./-]{6,30})/i);
  const date = parseDate(labelledDate?.[1] || '', { today }) || parseDate(flat, { today });
  if (date) { found.occurredOn = date; sources.occurredOn = 'document'; }

  const org = matchInLines(
    lines,
    /\b(?:presented by|issued by|on behalf of|organi[sz]ation)\s*[:-]?\s*(.+)$/i,
  );
  if (org) { found.organizationName = tidy(org); sources.organizationName = 'document'; }

  const activity = matchInLines(
    lines,
    /\b(?:for(?: their)? (?:service|volunteering|participation) (?:at|in|with)|activity|event)\s*[:-]?\s*(.+)$/i,
  );
  if (activity) { found.activityName = tidy(activity); sources.activityName = 'document'; }

  return { fields: found, sources };
}

/**
 * First capture from the first line that matches.
 *
 * Patterns take the rest of the line; `tidy` cuts it at the next clause. That
 * one rule covers both shapes a certificate arrives in — properly broken lines,
 * where the line end does the work, and a page whose fragments arrived unbroken,
 * where the clause boundary does.
 */
function matchInLines(lines, pattern) {
  for (const line of lines) {
    const m = line.match(pattern);
    if (m && m[1] && m[1].trim()) return m[1];
  }
  return null;
}

/**
 * Words that begin the next clause on a certificate.
 *
 * A captured value is cut before the first of these. Line ends normally do this
 * job, and on a real PDF they do — but `hasEOL` is a viewer's reconstruction of
 * a layout that has no lines in it, so it is not something to depend on
 * absolutely. Without this, a page whose fragments arrive unbroken yields
 * "Environmental Club This certifies that Leo Chen completed 4 h": a value
 * wrong in the worst way, because it looks like a reading rather than a
 * failure.
 */
const NEXT_CLAUSE = /\s+(?:this\s+certifies|certifies|date\b|dated\b|hours?\b|hrs?\b|for\s+their\s+service|in\s+recognition|awarded\b|presented\b|issued\b|on\s+behalf)/i;

function tidy(value) {
  const raw = String(value).replace(/\s+/g, ' ').trim();
  const cut = raw.search(NEXT_CLAUSE);
  return (cut > 0 ? raw.slice(0, cut) : raw)
    .replace(/[,.\s]+$/, '')
    .trim()
    .slice(0, 200);
}

/**
 * Keep only the fields that would survive being submitted.
 *
 * Extraction output is untrusted, whether a pattern or a model produced it.
 * Each field is checked on its own against the server's rules — the same
 * module the route uses — and anything that fails is dropped rather than
 * shown. A student correcting a plausible wrong value is a worse experience
 * than filling an empty one, and an unfixable value that only fails on submit
 * is worse than both.
 */
export function keepValidFields(fields) {
  const kept = {};
  const rejected = [];

  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    const check = validateExternalHours({ [key]: value }, { partial: true });
    if (check.ok && check.value[key] !== undefined) kept[key] = check.value[key];
    else rejected.push(key);
  }
  return { fields: kept, rejected };
}
