/**
 * A minimal, single-page PDF writer — enough to lay out one certificate, and
 * deliberately not one line more.
 *
 * ── Why this exists rather than a library ──
 *
 * The requirement is a real file a volunteer can download on a phone, not a
 * print dialog. Four ways to get one were considered:
 *
 *   1. **Headless Chrome** (`puppeteer`, `playwright`). Correct output, and it
 *      brings a ~170 MB browser download, a second process per request, and a
 *      sandbox to keep patched — on a single small host that also serves the
 *      app. It is the heaviest possible dependency for one page of text.
 *   2. **`pdfkit`** (~1.5 MB with its font machinery) or **`pdf-lib`** (~350 kB).
 *      Both are fine libraries. Both are a new dependency for a document whose
 *      entire content is fourteen lines of centred text, two rules and a QR
 *      code — and this repository's standing rule (see `telemetrySink.js` on
 *      `@logtail/node`, and `AdminImpact.jsx` on `html2canvas`) is that a
 *      dependency has to earn its place against what it actually replaces.
 *   3. **Client-side canvas capture.** Rejected on the same grounds
 *      `AdminImpact.jsx` records: it photographs the live DOM, so the artefact
 *      inherits scroll position, hover states, fonts that may not have loaded,
 *      and whatever the reader's zoom was — and the failure mode is a silently
 *      wrong document that somebody hands to a college.
 *   4. **This.** ~250 lines, no dependency, byte-for-byte deterministic, and the
 *      output is checked in `server/certificatePdf.test.js` by parsing the file
 *      back with `pdfjs-dist` — which is already a dependency of this project —
 *      and asserting the recipient's name is really in it.
 *
 * The scope is what makes (4) reasonable. There is one page, one size, no
 * images, no embedded fonts, no compression, no encryption, no forms, no
 * outline, no incremental update. Anything that needs those needs a library,
 * and that is the moment to add one.
 *
 * ── The base-14 fonts, and why no font is embedded ──
 *
 * PDF viewers are required to provide Helvetica, Times and Courier. Using them
 * means no font file to embed, no licensing question, and a file measured in
 * kilobytes. The cost is that this module must know their metrics to centre
 * anything — a PDF has no notion of alignment — which is what `WIDTHS` below is.
 * Those are Adobe's published AFM widths for the standard fonts.
 */

/** US Letter, landscape — the shape a certificate is printed in. */
export const PAGE = Object.freeze({ width: 792, height: 612 });

/**
 * Character widths in 1/1000 em, for ASCII 32–126, from the Adobe Font Metrics
 * for the base-14 fonts.
 *
 * Codes outside that range fall back to `DEFAULT_WIDTH`. That is deliberate and
 * bounded: the only strings here that can carry an accented character are a
 * person's name and an event title, the error is a fraction of an em on a
 * centred line, and the alternative — a full 256-entry table per font — is four
 * times the data to move a glyph by half a point.
 */
const DEFAULT_WIDTH = 500;

const WIDTHS = {
  'Helvetica': [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  'Helvetica-Bold': [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
  'Times-Roman': [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
    921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
    556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
    333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
    500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
  ],
  'Times-Bold': [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
    930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
    611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
    333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
    556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
  ],
};

/** The fonts this writer offers, in the order they are declared in the file. */
export const FONTS = Object.freeze(Object.keys(WIDTHS));

/**
 * The width of `text` at `size`, including any letter-spacing.
 *
 * Letter-spacing (`Tc`) is applied by the viewer AFTER every glyph including
 * the last, which is a detail that matters for centring: measuring without it
 * shifts a tracked line left by half a space.
 */
export function textWidth(text, font, size, tracking = 0) {
  const table = WIDTHS[font] || WIDTHS['Helvetica'];
  let total = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    total += (code >= 32 && code <= 126 ? table[code - 32] : DEFAULT_WIDTH) / 1000 * size;
    total += tracking;
  }
  return total;
}

/**
 * A string as PDF literal-string bytes, in WinAnsiEncoding.
 *
 * ── Why the mapping is explicit ──
 *
 * `(`, `)` and `\` end or escape a literal string, so an event title containing
 * a bracket would otherwise produce a corrupt file — which is a real title, not
 * a hypothetical one ("Beach Cleanup (Saturday)"). Anything above U+00FF has no
 * WinAnsi code point at all; the handful that actually occur in copy typed on a
 * Mac are folded to their ASCII equivalents rather than dropped, because a name
 * rendered with a `?` in it is worse than one rendered with a straight quote.
 */
const FOLD = new Map(Object.entries({
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', ' ': ' ',
  '·': '·',
}));

function escapeText(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const folded = FOLD.get(ch) ?? ch;
    for (const c of folded) {
      const code = c.codePointAt(0);
      if (code > 255) { bytes.push(0x3f); continue; } // '?'
      if (c === '(' || c === ')' || c === '\\') bytes.push(0x5c);
      bytes.push(code);
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

/** A colour as PDF's 0–1 triple. Accepts `#rrggbb`. */
function rgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return `${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`;
}

/**
 * A page's content stream, built by the drawing calls below.
 *
 * PDF's origin is BOTTOM-left and this exposes it that way rather than
 * flipping to a screen-like top-left coordinate system. A transform would make
 * the callers read like CSS and every text baseline read like a bug, because
 * text is still drawn upward from its baseline either way.
 */
export class Content {
  constructor() { this.ops = []; }

  /** Filled rectangle. */
  rect(x, y, w, h, color) {
    this.ops.push(`${rgb(color)} rg`, `${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
    return this;
  }

  /** Stroked rectangle. */
  strokeRect(x, y, w, h, color, lineWidth = 1) {
    this.ops.push(`${rgb(color)} RG`, `${n(lineWidth)} w`, `${n(x)} ${n(y)} ${n(w)} ${n(h)} re S`);
    return this;
  }

  /** Horizontal rule, centred on `x`. */
  rule(centerX, y, width, color, lineWidth = 1) {
    const half = width / 2;
    this.ops.push(
      `${rgb(color)} RG`, `${n(lineWidth)} w`,
      `${n(centerX - half)} ${n(y)} m ${n(centerX + half)} ${n(y)} l S`,
    );
    return this;
  }

  /** Text with its baseline at `y`, starting at `x`. */
  text(text, x, y, { font = 'Helvetica', size = 11, color = '#000000', tracking = 0 } = {}) {
    this.ops.push(
      'BT',
      `/F${FONTS.indexOf(font) + 1} ${n(size)} Tf`,
      `${n(tracking)} Tc`,
      `${rgb(color)} rg`,
      `${n(x)} ${n(y)} Td`,
      `(${escapeText(text)}) Tj`,
      'ET',
    );
    return this;
  }

  /** The same, centred on `centerX`. */
  centered(text, centerX, y, options = {}) {
    const { font = 'Helvetica', size = 11, tracking = 0 } = options;
    const width = textWidth(text, font, size, tracking);
    return this.text(text, centerX - width / 2, y, options);
  }

  /**
   * A QR code as filled squares, from `qrcode`'s module matrix.
   *
   * Vector, not a raster image. A PDF image XObject would need a bitmap, a
   * colour space and (to stay small) a Flate stream — three things this file
   * otherwise does not need — and it would blur when the certificate is
   * enlarged. Squares stay sharp at any zoom and at any printer resolution,
   * which is the whole point of a code somebody scans off paper.
   */
  qr(modules, x, y, size, color = '#000000') {
    const count = modules.size;
    const cell = size / count;
    this.ops.push(`${rgb(color)} rg`);
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (!modules.get(row, col)) continue;
        /* `y` is the BOTTOM of the code and rows run downward, so the row index
           is subtracted from the top. Drawn a hair oversized (cell + 0.02) so
           adjacent modules meet: at small sizes, exact-width squares leave
           hairline gaps that some renderers turn into visible white grid lines,
           and a scanner reads those as quiet zones. */
        this.ops.push(`${n(x + col * cell)} ${n(y + size - (row + 1) * cell)} ${n(cell + 0.02)} ${n(cell + 0.02)} re`);
      }
    }
    this.ops.push('f');
    return this;
  }

  toString() { return this.ops.join('\n'); }
}

/** Numbers, trimmed. PDF accepts plain decimals and nothing exotic. */
function n(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(rounded) ? String(rounded) : '0';
}

/**
 * Assembles one page into a complete PDF file.
 *
 * The cross-reference table is the part that has to be exactly right: it is a
 * list of byte offsets, and a viewer that cannot resolve one refuses the whole
 * document. So offsets are measured off the buffers themselves as they are
 * appended, never predicted — and `certificatePdf.test.js` opens the result
 * with a real PDF parser rather than pattern-matching the bytes.
 *
 * @param {Content} content
 * @param {{ title?: string, author?: string, subject?: string }} [meta]
 * @returns {Buffer}
 */
export function buildPdf(content, meta = {}) {
  const stream = content.toString();

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] `
      + `/Resources << /Font << ${FONTS.map((_, i) => `/F${i + 1} ${5 + i} 0 R`).join(' ')} >> >> `
      + '/Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    ...FONTS.map(font => `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`),
    /**
     * The document information dictionary.
     *
     * Present because it is what a file manager, a mail client and a college's
     * document system show as the file's title — "Certificate of Community
     * Service" rather than the filename, which the recipient may have renamed.
     * It carries no personal data beyond what is printed on the face of the
     * document itself.
     */
    `<< ${[
      meta.title ? `/Title (${escapeText(meta.title)})` : '',
      meta.author ? `/Author (${escapeText(meta.author)})` : '',
      meta.subject ? `/Subject (${escapeText(meta.subject)})` : '',
      '/Producer (WeVolunteer)',
    ].filter(Boolean).join(' ')} >>`,
  ];

  const chunks = [];
  let offset = 0;
  const push = (text) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };

  push('%PDF-1.4\n');
  /* A comment of high bytes, which is how a PDF declares itself binary. Without
     it, tools that sniff text-vs-binary can mangle the file in transit. */
  push('%\xE2\xE3\xCF\xD3\n');

  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefAt = offset;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
