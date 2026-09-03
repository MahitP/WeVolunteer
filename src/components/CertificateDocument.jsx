import React from 'react';
import { formatHours, formatDay, gradeLabel } from '../utils/helpers';

/**
 * The certificate itself — the paper, and nothing around it.
 *
 * ── Why the document is its own component ──
 *
 * It used to live inside `CertificateModal`, tangled with the dialog's chrome,
 * its close button and its footer. That was fine while there was one place to
 * show a certificate. There are now two contexts that need the identical
 * artefact — the viewer at `/certificates/:code`, and the print stylesheet,
 * which isolates `#printable-certificate` and hides everything else — and a
 * document that is defined inside one of its containers cannot be reused by the
 * other without dragging the container along.
 *
 * ── The paper stays light in dark mode, and that is deliberate ──
 *
 * `--cert-bg`, `--cert-text`, `--cert-border` and `--cert-accent` are the one
 * block in `src/index.css` that is NOT overridden for dark mode, and the
 * comment there says why: this is a printed document, it is designed for print
 * fidelity, and an inverted certificate is a certificate that comes out of a
 * printer as a black rectangle. The page AROUND it is fully themed — see
 * `CertificateView.jsx` — so a reader in dark mode gets a dark page holding a
 * sheet of paper, which is what the artefact actually is.
 *
 * `--cert-accent` exists for the same reason and is worth not undoing: the
 * volunteer's name was styled with `--brand-ink`, which IS redefined for dark
 * mode, and on cream paper that pale mint measured 1.54:1 — on the single most
 * important word in the document.
 *
 * ── Every field degrades visibly ──
 *
 * `{volunteer?.name}` alone renders an empty element when the prop is missing,
 * so the finished certificate has a blank where its subject belongs — printed,
 * signed, and handed to a college with nobody's name on it. A document that is
 * silently wrong is worse than one that says it is incomplete, so each missing
 * value says so.
 */
export default function CertificateDocument({ certificate, volunteer, headingLevel = 2 }) {
  if (!certificate) return null;

  /**
   * ── Why this is an `h2` by default and not the `h1` it used to be ──
   *
   * The document renders inside the app shell, and the shell already supplies
   * the page's `h1` (`topbar-title`, App.jsx). A second `h1` here gave
   * `/certificates/:code` two of them, which contradicts the one-per-route rule
   * `a11y/sweep.aria.spec.js` enforces at runtime. That contradiction went
   * unnoticed only because the sweep never reached this page: certificate codes
   * are random, so its typed fixture resolves to nothing and it measured the
   * not-found panel instead. See `a11y/workflows/certificate.spec.js`.
   *
   * `headingLevels.test.js` used to exempt this file, on the reasoning that
   * print hides the shell so demoting the heading "would leave the printed
   * document with no heading at all". That is not what demoting does — it
   * leaves an `h2`: still a heading, still the largest thing on the paper. The
   * exemption is therefore removed rather than kept.
   *
   * The type scale had to be uncoupled from the tag for that to be true. It was
   * `.certificate h1 { font-size: 2rem }` (and `1.5rem` in the narrow
   * breakpoint), so demoting the tag alone would have silently shrunk the
   * document's title to the browser's default `h2`. Both selectors are now
   * `.certificate-title`, which is what the tag being a prop requires.
   *
   * A prop rather than a constant for the same reason `EmptyState` takes one:
   * if this document is ever rendered somewhere the shell does not supply an
   * `h1` — a standalone print view, a public verification page — that caller
   * can say so instead of this file guessing.
   */
  const asked = Number(headingLevel);
  const level = Number.isInteger(asked) && asked >= 1 && asked <= 6 ? asked : 2;
  const Heading = `h${level}`;

  const name = volunteer?.name || certificate.volunteer?.name || 'Name unavailable';
  const grade = volunteer?.grade ?? certificate.volunteer?.grade ?? null;
  const context = [certificate.organizationName, certificate.location, formatDay(certificate.startDatetime)]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="certificate" id="printable-certificate">
      {/* Only the body is centred. The signature blocks below it are a flex row
          and their captions are left-aligned under each rule, which is how a
          signed document reads — centring them would caption nothing. */}
      <div className="certificate-body">
        <div className="certificate-org">WeVolunteer Network</div>
        <div className="certificate-rule" />
        <Heading className="certificate-title">Certificate of Community Service</Heading>

        <p className="certificate-lede">This certifies that</p>
        <div className="certificate-name">{name}</div>
        {gradeLabel(grade) && <p className="certificate-sub">{gradeLabel(grade)}</p>}

        <p className="certificate-lede">volunteered at</p>
        <div className="certificate-event">{certificate.title}</div>
        {context && <p className="certificate-sub">{context}</p>}

        <div className="certificate-hours">{formatHours(certificate.hours)}</div>
        <p className="certificate-sub">of verified community service</p>
      </div>

      {/**
        * Two parties, two rules.
        *
        * A certificate of service is a claim about a volunteer that an
        * organizer attests to, and the document named its subject in the body
        * and then presented a single signature — which reads as an organizer
        * signing something about themselves. Both names sit ABOVE their rule
        * with the capacity below it, the way a signed document is laid out.
        * `.certificate-sign`'s `min-height` is what keeps the two rules on one
        * line when one name wraps and the other does not.
        */}
      <div className="certificate-foot">
        <div className="certificate-sign-block">
          <div className="certificate-sign">{name}</div>
          <div className="certificate-sign-label">Volunteer</div>
        </div>
        <div className="certificate-sign-block">
          <div className="certificate-sign">
            {certificate.organizerName || 'Organizer unavailable'}
            {certificate.organizerVerified && ' · Verified organizer'}
          </div>
          <div className="certificate-sign-label">Program Coordinator</div>
        </div>
      </div>

      {/**
        * The verification block — the code, where to check it, and the QR that
        * goes straight there.
        *
        * Centred beneath both signatures because the PLATFORM issues the code,
        * not either party. The QR is generated server-side and arrives as a
        * data URL (see `GET /api/certificates/:code`), so the browser needs no
        * encoder and the screen and the PDF cannot disagree about what the
        * certificate points at.
        *
        * `alt` names the destination rather than saying "QR code". A screen
        * reader user cannot scan it and does not need to: the verification
        * address is written out beside it as text, which is what the alt text
        * points them at.
        */}
      <div className="certificate-verify">
        <div className="certificate-verify-text">
          <div className="certificate-code">{certificate.code}</div>
          {/**
            * `.certificate-verify-where`, not `.certificate-sign-label`.
            *
            * That class is `text-transform: uppercase`, which is right for a
            * capacity ("VOLUNTEER") and wrong for a URL: it printed
            * "VERIFY AT WEVOLUNTEERS.ORG/VERIFY/WEV-…", and somebody typing an
            * address off paper should be typing what the address IS. A URL path
            * is case-sensitive in general; this one survives the transform only
            * because the code happens to be upper-case already, which is luck
            * rather than design.
            */}
          <div className="certificate-verify-where">
            Verify at {certificate.verifyLabel || certificate.verifyUrl}
          </div>
        </div>
        {/* After the code in reading order: the code is what a school office
            types, the QR is the shortcut for somebody holding a phone. Same
            order as the PDF. */}
        {certificate.qr && (
          <img
            className="certificate-qr"
            src={certificate.qr}
            alt={`Scan to verify this certificate at ${certificate.verifyLabel || ''}`}
            width={96}
            height={96}
          />
        )}
      </div>
    </div>
  );
}
