/**
 * One certificate, for the person it belongs to.
 *
 * ── Why these are separate from the list in `attendanceRoutes.js` ──
 *
 * `GET /api/certificates` answers "what have I earned" and is part of the
 * attendance story, which is where it lives. These two answer "show me this
 * one" and "give me the file", they carry a QR encoder and a PDF writer with
 * them, and the second returns bytes rather than JSON. Bolting them onto a
 * 900-line attendance router would put a document generator inside the file
 * that decides whether a shift counts.
 *
 * Mounted after `attendanceRoutes`, though nothing depends on that:
 * `/api/certificates/verify/:code` has two path segments after the collection
 * and `/api/certificates/:code` has one, so they cannot capture each other.
 *
 * ── Authorization: ownership, not a capability ──
 *
 * The same rule `GET /api/certificates` already follows and is registered under
 * in `authz.completeness.test.js`: no capability gate, and every query scoped to
 * `user_id = caller`. A capability would be the wrong instrument — reading your
 * own certificate is not a privilege somebody grants, and gating it on
 * `portfolio.write` would refuse an administrator who volunteered, which is a
 * real account on this platform.
 *
 * What matters is what the scoping REFUSES: somebody else's code, held by
 * whatever means, gets the same 404 as a code that does not exist. That is
 * deliberate. A distinct "this is not yours" response would turn this route
 * into an oracle for whether a given code is live — and the code is a bearer
 * credential printed on paper (see `server/certificates.js`), so confirming one
 * exists is most of the way to confirming whose it is.
 *
 * Verifying somebody else's certificate is what `GET
 * /api/certificates/verify/:code` is for, and it discloses only what is printed
 * on the face of the document.
 */
import express from 'express';
import QRCode from 'qrcode';

import { authenticateToken } from '../utils.js';
/* Held only to hand on. Every query lives in `certificates.js`, which takes the
   handle as a parameter — see the note there and `db.accessSurface.test.js`. */
import { db } from '../db.js';
import { getCertificateForOwner } from '../certificates.js';
import { buildCertificatePdf, certificateFilename } from '../certificatePdf.js';

const router = express.Router();

/**
 * The public origin this deployment is reached at.
 *
 * `APP_URL` first, and in production that is the only answer: `server/email.js`
 * refuses to boot without it, validates that it is absolute HTTPS, and every
 * password-reset link in the product is already built from it. The request's own
 * `Host` header is the development fallback ONLY — it is client-supplied, and a
 * verification URL built from an attacker-chosen host is a phishing link with
 * this platform's name on it.
 */
function publicOrigin(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '';
  return `${req.protocol}://${req.get('host')}`;
}

/** "12 hrs", "1 hr 30 min" — the same wording `src/utils/helpers.js` uses. */
function formatHours(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '0 hrs';
  const totalMinutes = Math.round(h * 60);
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const hrsStr = hrs > 0 ? `${hrs} hr${hrs === 1 ? '' : 's'}` : '';
  const minsStr = mins > 0 ? `${mins} min` : '';
  return [hrsStr, minsStr].filter(Boolean).join(' ') || '0 hrs';
}

/**
 * A full date WITH the year — "14 March 2026".
 *
 * Deliberately not `formatDay` from the client helpers, which is "Sat, Jul 11".
 * That is right for a dashboard row read this week and wrong for a document
 * somebody produces to a college three years later: a certificate with no year
 * on it does not say when the service happened.
 */
function formatFullDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "Grade 11", or nothing. Mirrors `gradeLabel` in `src/utils/helpers.js`. */
function gradeLabel(grade) {
  if (!grade || grade === 'N/A') return '';
  return /^\d+$/.test(String(grade)) ? `Grade ${grade}` : String(grade);
}

/**
 * `GET /api/certificates/:code`
 *
 * Everything the viewer draws, plus the QR image, in one request.
 *
 * ── Why the QR is generated here and not in the browser ──
 *
 * A QR encoder in the bundle is ~20 kB that every visitor downloads for a page
 * most of them never open, and `qrcode` is already a server dependency (the
 * two-factor enrolment screen uses it). Generating it here also means the code
 * on the screen and the code in the PDF come from one encoder with one error-
 * correction level, rather than from two implementations that can disagree
 * about what the certificate points at.
 *
 * It is returned as a data URL so the page needs no second request and no image
 * route to authorize.
 */
router.get('/api/certificates/:code', authenticateToken, async (req, res) => {
  try {
    const found = await getCertificateForOwner(db, req.params.code, req.user.id);
    /* Not yours, not real, and not for an event that was called off all answer
       the same way. See the header: a distinguishable refusal makes this route
       an oracle for live certificate codes. */
    if (!found) return res.status(404).json({ error: 'No certificate matches that code.' });

    const { cert, row, volunteer } = found;
    const origin = publicOrigin(req);
    const path = `/verify/${cert.code}`;

    res.json({
      code: cert.code,
      issuedAt: cert.created_at,
      eventId: row.event_id,
      title: row.title,
      category: row.category,
      location: row.location,
      hours: Number(row.hours),
      shifts: row.shifts,
      startDatetime: row.first_start,
      endDatetime: row.last_end,
      organizerName: row.organizer_name,
      organizerVerified: row.organizer_verified === 1,
      organizationName: row.organization_name ?? null,
      organizationSlug: row.organization_slug ?? null,
      /* The certificate stands; the hours are not in the student's totals.
         Both halves are true at once when an event is called off after a
         certificate was issued, and the viewer says so. See the header of
         `getCertificateForOwner`. */
      eventCancelled: row.status === 'cancelled',
      volunteer: {
        name: volunteer?.name ?? null,
        grade: volunteer?.grade ?? null,
      },
      /* Both spellings. The absolute URL is what the QR encodes and what the
         share sheet hands to another application; the label is what is PRINTED
         on the document, where a scheme is noise a reader has to skip past. */
      verifyUrl: `${origin}${path}`,
      verifyLabel: `${origin.replace(/^https?:\/\//, '')}${path}`,
      qr: await QRCode.toDataURL(`${origin}${path}`, {
        errorCorrectionLevel: 'M',
        margin: 1,
        /* Explicit, and not tokens: this image is drawn on the certificate's
           own paper, which is deliberately light in both themes (see the
           `--cert-*` block in src/index.css), and a code that inverted with the
           app theme would stop scanning in dark mode. */
        color: { dark: '#1c1917ff', light: '#ffffffff' },
        width: 320,
      }),
    });
  } catch (err) {
    console.error('Certificate detail error:', err);
    res.status(500).json({ error: 'Could not load that certificate.' });
  }
});

/**
 * `GET /api/certificates/:code/pdf`
 *
 * The same document as a file. Generated on demand rather than stored: it is a
 * pure function of rows this database already holds, it takes a few
 * milliseconds, and storing it would mean a certificate whose organizer's name
 * was later corrected still downloads the old one.
 */
router.get('/api/certificates/:code/pdf', authenticateToken, async (req, res) => {
  try {
    const found = await getCertificateForOwner(db, req.params.code, req.user.id);
    if (!found) return res.status(404).json({ error: 'No certificate matches that code.' });

    const { cert, row, volunteer } = found;
    const origin = publicOrigin(req);

    const pdf = await buildCertificatePdf({
      /* The same visible admission the screen version makes when the name is
         missing. A signature line with nothing on it is indistinguishable from
         an unsigned certificate; a document that is silently wrong is worse
         than one that says it is incomplete. */
      recipientName: volunteer?.name || 'Name unavailable',
      gradeLabel: gradeLabel(volunteer?.grade),
      eventTitle: row.title,
      organizationName: row.organization_name ?? null,
      location: row.location ?? null,
      hoursLabel: formatHours(row.hours),
      dateLabel: formatFullDate(row.last_end),
      organizerName: row.organizer_name || 'Organizer unavailable',
      organizerVerified: row.organizer_verified === 1,
      code: cert.code,
      verifyUrl: `${origin}/verify/${cert.code}`,
    });

    res.setHeader('Content-Type', 'application/pdf');
    /* `attachment`, so the browser saves it instead of opening its own PDF
       viewer — which is the reader experience this whole feature replaced. The
       filename carries the code and never the volunteer's name: a file called
       `certificate-ana-ramirez.pdf` in a shared Downloads folder discloses
       something the certificate's owner did not choose to. */
    res.setHeader('Content-Disposition', `attachment; filename="${certificateFilename(cert.code)}"`);
    /* Private: this is one person's document and a shared cache must never hold
       it. `no-store` rather than a max-age, for the same reason. */
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (err) {
    console.error('Certificate PDF error:', err);
    res.status(500).json({ error: 'Could not produce that certificate.' });
  }
});

export default router;
