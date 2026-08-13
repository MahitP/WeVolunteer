/**
 * Build-time flags.
 *
 * Demo mode is opt-in, never opt-out. It gates the account switcher and the
 * one-click seeded sign-ins — scaffolding for exploring the product, which in
 * a real deployment would be a way to sign in as anyone with a published
 * password. A production build has no VITE_DEMO_MODE, so this is false and
 * both disappear.
 *
 * The server has a matching DEMO_MODE flag guarding the reset endpoint. The
 * two are independent on purpose: neither can switch the other on.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

// Global application configurations
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'WeVolunteer';
export const SCHOOL_NAME = import.meta.env.VITE_SCHOOL_NAME || 'WeVolunteer Community';
export const ENABLE_LEADERBOARD = import.meta.env.VITE_ENABLE_LEADERBOARD !== 'false';

/**
 * Who signs a service transcript, and in what capacity.
 *
 * ── Why this is configuration and not profile data ──
 *
 * A transcript is a document the PLATFORM issues about somebody's service. The
 * signature is the platform's authorised issuer, which is a property of the
 * deployment — not of the student whose record it is, and not of whichever
 * organizer happened to confirm the last shift.
 *
 * Deliberately NOT read from a user row. Joining the signature to an account
 * would mean the document silently changes when that account is renamed or
 * deleted, and it would make an ordinary profile edit a change to the meaning of
 * every transcript already issued.
 *
 * Overridable per deployment, because a district running its own instance signs
 * its own transcripts.
 */
export const DOCUMENT_SIGNATORY = import.meta.env.VITE_DOCUMENT_SIGNATORY || 'Mahit Pulavarthi';
export const DOCUMENT_SIGNATORY_TITLE =
  import.meta.env.VITE_DOCUMENT_SIGNATORY_TITLE || `Founder of ${APP_NAME}`;

/**
 * Where the district's privacy notice lives.
 *
 * This platform holds identifying information about minors — names, grades,
 * schools, email addresses — and shows some of it to other users (organizers
 * see contact details for students who apply to their events). Nothing in the
 * product told a student or parent what is collected, who can see it, how long
 * it is kept, or how to have it removed.
 *
 * Deliberately empty by default, and every control that depends on it renders
 * only when it is set. Shipping placeholder legal text would be worse than
 * shipping none: it would create the appearance of a reviewed policy where
 * none exists. The district supplies the URL; this only wires it in.
 *
 * Set VITE_PRIVACY_URL at build time to switch on the signup acknowledgement.
 * It may be an external URL, or the built-in notice at `/privacy` — see
 * PRIVACY_CONTACT below for what the built-in page will and will not claim.
 */
/**
 * Defaults to the built-in notice, no longer to the empty string.
 *
 * The empty default made sense when there was nothing to point at: a link to
 * nowhere is worse than no link. `/privacy` now exists and is reachable signed
 * out, so silence is no longer the honest default — it is just a broken link
 * dressed as caution.
 *
 * This mattered more than it looked. The signup consent control was wrapped in
 * `{PRIVACY_URL && …}`, so with the empty default a stock build rendered NO
 * consent control at all. Combined with `baseFields()` never sending the
 * answer, the platform collected nothing and could prove nothing. The gate is
 * gone from the markup and the server now refuses a signup without consent;
 * this makes the link resolve to something real in every build.
 *
 * Still overridable for a deployment that publishes its own notice elsewhere.
 *
 * ── Now points at the registry document, not the built-in notice ──
 *
 * This is the link inside the signup consent block, so it is what a student opens
 * while being asked to acknowledge how their information is handled. It defaulted
 * to `/privacy`, the hand-written page built from the values below — which is not
 * the document their acceptance is recorded against. `/legal/privacy-policy`
 * serves the published Privacy Policy out of `server/legalDocuments.js`,
 * hash-verified on every read and carrying the version stored with the acceptance.
 *
 * The consent link and the consent record now name the same document. `/privacy`
 * still resolves — it redirects there (see `src/routes/index.jsx`).
 */
export const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL || '/legal/privacy-policy';

/**
 * The three facts the built-in privacy notice cannot know, and must not invent.
 *
 * ── Why these are separate values and not prose in the page ──
 *
 * `/privacy` states what this software collects and who it shows it to. Those
 * are engineering facts, readable from the schema and the route handlers, and
 * writing them down is a straightforward improvement over the status quo, which
 * is silence.
 *
 * These three are not that. How long a district keeps student records, who a
 * family contacts to correct or delete them, and what consent applies below 13
 * are decisions a district makes and is accountable for. Software cannot
 * supply them, and a plausible-looking default would be the exact failure the
 * PRIVACY_URL comment above exists to prevent — it would manufacture the
 * appearance of a policy somebody had reviewed.
 *
 * So they are empty by default and the page says loudly that it is incomplete
 * until they are filled in. An unfinished notice that admits it is unfinished
 * is honest. One that quietly reads as finished is not.
 */
export const PRIVACY_CONTACT = import.meta.env.VITE_PRIVACY_CONTACT || '';
export const PRIVACY_RETENTION = import.meta.env.VITE_PRIVACY_RETENTION || '';
export const PRIVACY_UNDER13 = import.meta.env.VITE_PRIVACY_UNDER13 || '';

/**
 * Who adopted this notice. Shown so a reader knows whose policy they are
 * reading rather than assuming it is the software vendor's.
 */
export const PRIVACY_OWNER = import.meta.env.VITE_PRIVACY_OWNER || '';

/** True only when a district has supplied every value the notice needs. */
export const privacyNoticeComplete = () =>
  Boolean(PRIVACY_CONTACT && PRIVACY_RETENTION && PRIVACY_UNDER13 && PRIVACY_OWNER);

/**
 * The origin printed on a certificate, for whoever has to verify it.
 *
 * This used to be the literal string "wevolunteer.org", which meant every
 * printed certificate directed a school office to a domain the district does
 * not control, no matter where the app was actually deployed.
 *
 * The default is the origin the page is being served from, which is correct
 * without any configuration: the person printing is already on the right host.
 * VITE_PUBLIC_URL exists to override it for the case where certificates are
 * printed from somewhere other than the public address (a staging host, or an
 * internal hostname behind the district's proxy).
 *
 * Returns a bare origin with no trailing slash, e.g. "volunteers.example.org".
 */
export function publicOrigin() {
  const configured = import.meta.env.VITE_PUBLIC_URL;
  const raw = configured || (typeof window !== 'undefined' ? window.location.origin : '');
  return String(raw).replace(/\/+$/, '').replace(/^https?:\/\//, '');
}

/**
 * Help and support destinations.
 *
 * Deliberately empty by default, following the same rule as PRIVACY_URL: the
 * Help screen previously listed four items — Student Guide, Organizer Guide,
 * Report a Problem, About — each an `<a href="#">`. Every one of them scrolled
 * the page and did nothing. On a screen a student reaches when they are already
 * stuck, and next to a "Report a Problem" link in particular, a control that
 * silently fails is worse than an absent one: it spends the person's trust and
 * then their patience.
 *
 * Each entry renders only when the district has supplied a real destination.
 * SUPPORT_EMAIL is the one that matters most — it is the fallback that makes the
 * screen useful even with nothing else configured.
 */
export const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || '';
export const STUDENT_GUIDE_URL = import.meta.env.VITE_STUDENT_GUIDE_URL || '';
export const ORGANIZER_GUIDE_URL = import.meta.env.VITE_ORGANIZER_GUIDE_URL || '';
