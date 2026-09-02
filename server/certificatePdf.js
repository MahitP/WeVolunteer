/**
 * The certificate, as a downloadable PDF.
 *
 * ── Why a PDF exists at all now ──
 *
 * The only way to keep a certificate used to be `window.print()`. On a desktop
 * that is a perfectly good route to a file; on a phone — which is where most of
 * this platform's volunteers are — "print to PDF" is several taps deep, produces
 * a page-scaled screenshot of the browser's idea of the document, and on some
 * mobile browsers is not offered at all. A student asked for their service
 * record by a college needs a file, not a print dialog.
 *
 * Printing is NOT removed. It is still offered beside the download, because a
 * school office genuinely does want paper, and because the print stylesheet in
 * `src/index.css` (`@media print`, the certificate isolation rules) is a
 * working, tested surface that nothing here replaces.
 *
 * ── The layout mirrors the screen, and is not generated from it ──
 *
 * The same sequence, the same words, the same warm-paper palette as
 * `CertificateDocument.jsx`: heading, "This certifies that", the name, the
 * event, the hours, two signature blocks, the verification code and a QR code.
 * The two are written separately and deliberately — see `pdfWriter.js` on why
 * photographing the DOM was refused — so `certificatePdf.test.js` asserts the
 * FACTS that must appear in both (name, event, hours, code) rather than that
 * the two files look alike.
 *
 * ── What is on it, and what is deliberately not ──
 *
 * Everything printed here is already on the face of the certificate the
 * volunteer sees, and the document is generated only for its own owner. Grade
 * is included because it is on the screen version and a school's record wants
 * it; nothing else about the person is. There is no email address, no username,
 * no user id, no address, and the location line names the EVENT's location,
 * which the volunteer is already publishing when they show anybody the
 * certificate.
 */
import QRCode from 'qrcode';
import { Content, PAGE, buildPdf, textWidth } from './pdfWriter.js';

/**
 * The certificate palette, matching the `--cert-*` tokens in `src/index.css`.
 *
 * Duplicated as literals rather than imported, because CSS custom properties
 * are not readable from Node and a build step that extracted them would be a
 * build step to maintain. `certificatePdf.test.js` asserts these values against
 * the stylesheet, so the two cannot drift silently.
 */
export const CERT_COLORS = Object.freeze({
  paper: '#fffdf8',
  ink: '#1c1917',
  ink2: '#57534e',
  ink3: '#78716c',
  border: '#e7e2d6',
  accent: '#14532d',
});

/**
 * The truncation marker, spelled as three periods rather than as `…`.
 *
 * WinAnsiEncoding does have an ellipsis (0x85), and `pdfWriter.js` deliberately
 * carries width tables for ASCII only — everything above 126 measures as a
 * nominal 500/1000 em. For a letter inside a name that error is invisible; for
 * the character this code appends specifically to make a line FIT, measuring
 * one glyph and drawing another is how the clipped line ends up wider than the
 * column it was clipped for. Three periods measure exactly.
 */
const ELLIPSIS = '...';

/**
 * Wraps `text` to at most `maxLines` lines of `maxWidth`, ellipsising the last.
 *
 * The ellipsis is not cosmetic. A truncated event title that says it was
 * truncated is a formatting limit; one that does not is a document making a
 * claim about an event with a different name — and this document is the one
 * somebody hands to a college.
 */
function wrap(text, font, size, maxWidth, maxLines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];

  const lines = [];
  let line = '';
  let truncated = false;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    /* A single word wider than the column is accepted onto its own line and
       clipped below, rather than looping forever looking for a break. */
    if (!line || textWidth(candidate, font, size) <= maxWidth) { line = candidate; continue; }
    if (lines.length === maxLines - 1) { truncated = true; break; }
    lines.push(line);
    line = word;
  }
  lines.push(line);

  return lines.map((text, i) => {
    const isLast = i === lines.length - 1;
    const needsClip = textWidth(text, font, size) > maxWidth || (isLast && truncated);
    return needsClip ? ellipsise(text, font, size, maxWidth) : text;
  });
}

/** `text` shortened until it and a trailing marker fit `maxWidth`. */
function ellipsise(text, font, size, maxWidth) {
  let clipped = text;
  while (clipped.length > 1 && textWidth(clipped + ELLIPSIS, font, size) > maxWidth) {
    clipped = clipped.slice(0, -1).trimEnd();
  }
  return clipped + ELLIPSIS;
}

/**
 * @param {object} certificate
 * @param {string} certificate.recipientName
 * @param {string|null} [certificate.gradeLabel]
 * @param {string} certificate.eventTitle
 * @param {string|null} [certificate.organizationName]
 * @param {string|null} [certificate.location]
 * @param {string} certificate.hoursLabel   e.g. "12 hours"
 * @param {string} certificate.dateLabel    e.g. "14 March 2026"
 * @param {string} certificate.organizerName
 * @param {boolean} [certificate.organizerVerified]
 * @param {string} certificate.code
 * @param {string} certificate.verifyUrl    the full public verification URL
 * @returns {Promise<Buffer>}
 */
export async function buildCertificatePdf(certificate) {
  const c = new Content();
  const mid = PAGE.width / 2;

  /* Paper first, then two rules inset from the trim — the frame a certificate
     is expected to have, and the thing that makes an otherwise white page read
     as a document rather than as a letter. */
  c.rect(0, 0, PAGE.width, PAGE.height, CERT_COLORS.paper);
  c.strokeRect(24, 24, PAGE.width - 48, PAGE.height - 48, CERT_COLORS.border, 2);
  c.strokeRect(32, 32, PAGE.width - 64, PAGE.height - 64, CERT_COLORS.border, 0.5);

  let y = PAGE.height - 78;

  c.centered('WEVOLUNTEER NETWORK', mid, y, {
    font: 'Helvetica-Bold', size: 9, color: CERT_COLORS.ink3, tracking: 2.4,
  });
  y -= 22;
  c.rule(mid, y, 44, CERT_COLORS.accent, 2);
  y -= 34;

  c.centered('Certificate of Community Service', mid, y, {
    font: 'Times-Bold', size: 27, color: CERT_COLORS.ink,
  });
  y -= 42;

  c.centered('This certifies that', mid, y, {
    font: 'Times-Roman', size: 12, color: CERT_COLORS.ink2,
  });
  y -= 44;

  /**
   * The recipient's name, sized to fit rather than sized and hoped for.
   *
   * A long name at a fixed 34pt runs off both edges of the page, and the one
   * word on this document that must never be clipped is the name of the person
   * it is about. So the size steps down until it fits — the same decision the
   * screen version makes with `min()` on the font size.
   */
  const nameSize = fitSize(certificate.recipientName, 'Times-Bold', 34, 18, PAGE.width - 180);
  c.centered(certificate.recipientName, mid, y, {
    font: 'Times-Bold', size: nameSize, color: CERT_COLORS.accent,
  });
  y -= 22;

  if (certificate.gradeLabel) {
    c.centered(certificate.gradeLabel, mid, y, {
      font: 'Times-Roman', size: 11, color: CERT_COLORS.ink3,
    });
    y -= 20;
  }
  y -= 10;

  c.centered('volunteered at', mid, y, { font: 'Times-Roman', size: 12, color: CERT_COLORS.ink2 });
  y -= 28;

  for (const line of wrap(certificate.eventTitle, 'Times-Bold', 17, PAGE.width - 200, 2)) {
    c.centered(line, mid, y, { font: 'Times-Bold', size: 17, color: CERT_COLORS.ink });
    y -= 22;
  }

  const context = [certificate.organizationName, certificate.location, certificate.dateLabel]
    .filter(Boolean).join(' · ');
  if (context) {
    c.centered(context, mid, y, { font: 'Times-Roman', size: 10.5, color: CERT_COLORS.ink3 });
    y -= 24;
  }
  y -= 8;

  c.centered(certificate.hoursLabel, mid, y, {
    font: 'Times-Bold', size: 24, color: CERT_COLORS.accent,
  });
  y -= 18;
  c.centered('of verified community service', mid, y, {
    font: 'Times-Roman', size: 10.5, color: CERT_COLORS.ink2,
  });

  /**
   * Two signature blocks, at fixed positions near the foot.
   *
   * Fixed rather than flowing from `y`, because the two parties must sit on one
   * line whatever happened above them — a wrapped event title moving the
   * signatures up is the difference between a document and a draft. The screen
   * version solves the same problem with `min-height` on `.certificate-sign`.
   *
   * Both names sit ABOVE their rule with the capacity below it, which is how a
   * signed document is laid out, and which is what stops the certificate
   * reading as an organizer attesting to something about themselves.
   */
  const signY = 150;
  const blockWidth = 210;
  const leftX = 96;
  const rightX = PAGE.width - 96 - blockWidth;

  signature(c, leftX, blockWidth, signY, certificate.recipientName, 'Volunteer');
  signature(
    c, rightX, blockWidth, signY,
    certificate.organizerVerified
      ? `${certificate.organizerName} · Verified organizer`
      : certificate.organizerName,
    'Program Coordinator',
  );

  /**
   * The verification block: the code, where to check it, and the QR that goes
   * there directly.
   *
   * Centred beneath both signatures rather than attached to either, because the
   * platform issues the code — not the organizer. The QR sits to the right of
   * the text so that neither has to shrink to accommodate the other, and it is
   * drawn at 66pt: comfortably above the ~2cm at which a phone camera stops
   * finding a code reliably on paper.
   */
  const qrSize = 66;
  const modules = QRCode.create(certificate.verifyUrl, { errorCorrectionLevel: 'M' }).modules;

  /**
   * The block is laid out as a GROUP and then centred, rather than each half
   * centred on the page.
   *
   * Centring the text on `mid` and then placing the code beside it is the
   * obvious construction and it is wrong: the two overlap, and what they
   * overlap is the verification URL — the one line on the document that tells a
   * school office what to do with the code. Measuring the group (text column,
   * gap, code) and centring THAT keeps the pair balanced under the signatures
   * and keeps a guaranteed gap between them at any page width.
   */
  const textColumn = 214;
  const gap = 18;
  const groupLeft = mid - (textColumn + gap + qrSize) / 2;
  const textCenter = groupLeft + textColumn / 2;
  const qrLeft = groupLeft + textColumn + gap;

  c.rule(textCenter, 96, textColumn, CERT_COLORS.border, 0.5);
  c.centered(certificate.code, textCenter, 76, {
    font: 'Helvetica-Bold', size: 13, color: CERT_COLORS.ink, tracking: 1.6,
  });
  c.centered(`Verify at ${certificate.verifyUrl}`, textCenter, 60, {
    font: 'Helvetica', size: 8, color: CERT_COLORS.ink3, tracking: 0.3,
  });
  c.centered('Hours were confirmed by the organizer after the event.', textCenter, 48, {
    font: 'Helvetica', size: 7.5, color: CERT_COLORS.ink3,
  });

  /* A white quiet zone under the code. The paper is already near-white, but a
     scanner needs the margin to be uniform, and drawing it explicitly means the
     code stays readable if the paper colour ever changes. */
  c.rect(qrLeft - 6, 42, qrSize + 12, qrSize + 12, '#ffffff');
  c.qr(modules, qrLeft, 48, qrSize, CERT_COLORS.ink);

  return buildPdf(c, {
    title: `Certificate of Community Service — ${certificate.eventTitle}`,
    author: 'WeVolunteer',
    subject: `${certificate.hoursLabel} of verified community service`,
  });
}

function signature(c, x, width, y, name, caption) {
  const center = x + width / 2;
  const size = fitSize(name, 'Times-Roman', 13, 8.5, width);
  c.centered(name, center, y + 8, { font: 'Times-Roman', size, color: CERT_COLORS.ink });
  c.rule(center, y, width, CERT_COLORS.border, 0.75);
  c.centered(caption.toUpperCase(), center, y - 14, {
    font: 'Helvetica', size: 7.5, color: CERT_COLORS.ink3, tracking: 1.2,
  });
}

/** The largest size at or below `max` at which `text` fits `maxWidth`. */
function fitSize(text, font, max, min, maxWidth) {
  let size = max;
  while (size > min && textWidth(text, font, size) > maxWidth) size -= 0.5;
  return size;
}

/** The filename a browser saves it under. ASCII only, and never a person's name. */
export function certificateFilename(code) {
  return `wevolunteer-certificate-${String(code).replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}
