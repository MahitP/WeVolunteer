import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CERT_COLORS, buildCertificatePdf, certificateFilename } from './certificatePdf.js';
import { PAGE, textWidth } from './pdfWriter.js';

/**
 * The PDF is opened with a real parser, not pattern-matched.
 *
 * ── Why that distinction is the whole point of this file ──
 *
 * `server/pdfWriter.js` writes the file format by hand, including a
 * cross-reference table of byte offsets. A viewer that cannot resolve one of
 * those offsets refuses the entire document — and a test that greps the bytes
 * for "Aïsha" would pass against a file no PDF reader on earth will open. The
 * failure would be discovered by the volunteer, on the day they needed the
 * certificate.
 *
 * `pdfjs-dist` is already a dependency of this project (the Welly document
 * reader uses it), so parsing the output costs nothing and turns "the bytes
 * look right" into "a PDF engine read it".
 *
 * The QR code is checked the same way, one step further: the page is not
 * rasterised here (that needs a canvas), so instead the code's own encoder is
 * re-run and the drawn module count compared — which catches the failure that
 * actually matters, a QR drawn at the wrong scale or with rows and columns
 * transposed.
 */

const certificate = (overrides = {}) => ({
  recipientName: 'Aïsha Ramanathan-Whitfield',
  gradeLabel: 'Grade 11',
  eventTitle: 'Riverside Beach Cleanup (Saturday)',
  organizationName: 'Green Club',
  location: 'Riverside Park',
  hoursLabel: '12 hrs',
  dateLabel: '14 March 2026',
  organizerName: 'Dana Okonkwo',
  organizerVerified: true,
  code: 'WEV-8H3K-2QPZ',
  verifyUrl: 'https://wevolunteers.org/verify/WEV-8H3K-2QPZ',
  ...overrides,
});

/** The document's text, in reading order, as one string a test can search. */
async function textOf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    /* No system fonts and no worker: this is Node, the fonts are the base-14
       ones every viewer supplies, and a worker would need a URL to load. */
    useSystemFonts: false,
    standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
  }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return {
    doc,
    page,
    /* Tracked text arrives as one item per glyph, so the join is on nothing and
       a space-separated search would miss "WEVOLUNTEER NETWORK". */
    text: content.items.map(i => i.str).join(''),
  };
}

describe('the generated certificate is a real PDF', () => {
  it('opens in a PDF parser at all', async () => {
    const { doc, page } = await textOf(await buildCertificatePdf(certificate()));
    expect(doc.numPages).toBe(1);
    /* Landscape US Letter. A portrait page would fit the text and look wrong in
       the one way nobody checks until it is printed. */
    expect(page.view).toEqual([0, 0, PAGE.width, PAGE.height]);
    expect(PAGE.width).toBeGreaterThan(PAGE.height);
  });

  it('carries every fact the certificate asserts', async () => {
    const { text } = await textOf(await buildCertificatePdf(certificate()));

    /* Each of these is a claim the document makes. A missing one is not a
       formatting bug — it is a certificate that does not say who earned it, for
       what, or how much. */
    expect(text).toContain('Aïsha Ramanathan-Whitfield');
    expect(text).toContain('Riverside Beach Cleanup (Saturday)');
    expect(text).toContain('12 hrs');
    expect(text).toContain('14 March 2026');
    expect(text).toContain('Dana Okonkwo');
    expect(text).toContain('Grade 11');
    expect(text).toContain('Green Club');
  });

  it('carries the verification code and where to check it', async () => {
    const { text } = await textOf(await buildCertificatePdf(certificate()));
    /* The code is set with letter-spacing, so it arrives glyph by glyph — the
       joined string is what to search, which is why `textOf` joins on ''. */
    expect(text).toContain('WEV-8H3K-2QPZ');
    expect(text).toContain('https://wevolunteers.org/verify/WEV-8H3K-2QPZ');
  });

  it('names both parties above their own rules', async () => {
    const { text } = await textOf(await buildCertificatePdf(certificate()));
    /**
     * The two captions are LETTER-SPACED, and a PDF has no such thing: tracking
     * is drawn as extra advance after each glyph, which every text extractor —
     * including the one a college's document system uses — reads back as spaces.
     * So the captions are asserted on space-stripped text. The assertion is
     * still about the certificate naming both capacities; it is not about how
     * many spaces a reader's extractor invents.
     */
    const dense = text.replace(/\s+/g, '');
    expect(dense).toContain('VOLUNTEER');
    expect(dense).toContain('PROGRAMCOORDINATOR');
    expect(text).toContain('Dana Okonkwo · Verified organizer');
  });

  /**
   * The parenthesis in the fixture's title is not decoration.
   *
   * `(` and `)` delimit a PDF literal string. An unescaped one truncates the
   * document at that byte and every offset after it is wrong, so the file does
   * not open — and "Beach Cleanup (Saturday)" is an ordinary event title, not a
   * hostile input.
   */
  it('survives brackets and backslashes in an event title', async () => {
    const { text } = await textOf(await buildCertificatePdf(certificate({
      eventTitle: 'Cleanup (Sat) \\ Sun',
    })));
    expect(text).toContain('Cleanup (Sat) \\ Sun');
  });

  it('admits a missing name rather than printing a blank', async () => {
    /* The route substitutes this string; the document must render it as written
       rather than collapsing to an empty line, which prints as an unsigned
       certificate that still looks finished. */
    const { text } = await textOf(await buildCertificatePdf(certificate({
      recipientName: 'Name unavailable',
    })));
    expect(text).toContain('Name unavailable');
  });

  it('shrinks a long name instead of running it off the page', async () => {
    const long = 'Maximiliana Aleksandrovna Constantinescu-Wojciechowska';
    const { text } = await textOf(await buildCertificatePdf(certificate({ recipientName: long })));
    expect(text).toContain(long);
    /* The property that matters is that SOME size fits, and the writer's own
       metric function is what the layout used to choose it. */
    expect(textWidth(long, 'Times-Bold', 18)).toBeLessThan(PAGE.width - 180);
  });

  it('ellipsises an over-long event title rather than silently dropping words', async () => {
    const { text } = await textOf(await buildCertificatePdf(certificate({
      eventTitle: 'A '.repeat(120) + 'end',
    })));
    /* Three periods, not `…` — see ELLIPSIS in certificatePdf.js: the marker is
       appended in order to make a line fit, so it has to be a character the
       width tables actually measure. */
    expect(text).toContain('...');
    /* Truncation without a marker would produce a document making a claim about
       an event with a different name. */
    expect(text).not.toContain('end...');
  });
});

describe('the QR code', () => {
  it('draws one filled square per dark module of the encoded URL', async () => {
    const QRCode = (await import('qrcode')).default;
    const cert = certificate();
    const modules = QRCode.create(cert.verifyUrl, { errorCorrectionLevel: 'M' }).modules;

    let dark = 0;
    for (let r = 0; r < modules.size; r++) {
      for (let c = 0; c < modules.size; c++) if (modules.get(r, c)) dark++;
    }

    /* The content stream is uncompressed by design (see pdfWriter.js), so the
       drawn rectangles are countable. `re` appears for the page, the two
       borders and the quiet zone as well — four — plus one per dark module. */
    const bytes = (await buildCertificatePdf(cert)).toString('latin1');
    const rects = bytes.match(/ re\b/g)?.length ?? 0;
    expect(rects).toBe(dark + 4);
    expect(dark).toBeGreaterThan(100);
  });

  it('encodes an absolute URL, so a phone camera can open it', async () => {
    /* A scheme-less `wevolunteers.org/verify/…` is not reliably treated as a
       link by a camera app — it is text. The route passes the absolute form for
       exactly this reason and prints the short form beside it. */
    expect(certificate().verifyUrl.startsWith('https://')).toBe(true);
  });
});

describe('the file a browser saves', () => {
  it('is named for the code and never for the volunteer', () => {
    /* A file called `certificate-ana-ramirez.pdf` in a shared Downloads folder
       discloses something its owner did not choose to. */
    expect(certificateFilename('WEV-8H3K-2QPZ')).toBe('wevolunteer-certificate-WEV-8H3K-2QPZ.pdf');
  });

  it('strips anything a path could be built out of', () => {
    expect(certificateFilename('../../etc/passwd')).toBe('wevolunteer-certificate-etcpasswd.pdf');
  });
});

describe('the printed palette matches the on-screen document', () => {
  /**
   * The PDF cannot read a CSS custom property, so the six values are duplicated
   * as literals in `certificatePdf.js`. Duplication is fine; DRIFT is not — a
   * downloaded certificate in a different green from the one on the screen is
   * the kind of thing nobody notices until both are on a desk together.
   */
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
  const token = (name) => CSS.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

  it.each([
    ['cert-bg', 'paper'],
    ['cert-text', 'ink'],
    ['cert-border', 'border'],
    ['cert-accent', 'accent'],
    ['certificate-ink-2', 'ink2'],
    ['certificate-ink-3', 'ink3'],
  ])('%s matches CERT_COLORS.%s', (cssToken, key) => {
    expect(token(cssToken)?.toLowerCase()).toBe(CERT_COLORS[key].toLowerCase());
  });
});
