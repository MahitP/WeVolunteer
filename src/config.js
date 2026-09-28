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
 * On-device AI. ON by default; `VITE_LOCAL_AI=false` opts a build out.
 *
 * ── Why the default points at ON ──
 *
 * It pointed the other way while the assistant was being built, and that was
 * right then and wrong the moment it was finished. Opt-in meant the feature was
 * absent from any build whose operator had not set a variable they had no reason
 * to know about — including production — and absent silently: no error, no
 * disabled control, just no launcher. The default now lives in `vite.config.js`,
 * which is committed, rather than in a `.env` that is not.
 *
 * ── Why still a build-time flag and not a runtime setting ──
 *
 * The inference runtime is a WebAssembly module and the models are hundreds of
 * megabytes. A deployment that opts out must not pay for it, and the only way to
 * guarantee that is to keep the import out of the bundle entirely rather than
 * behind a branch the bundler cannot prove is dead.
 *
 * So this flag gates the dynamic `import()` boundary in `src/ai/`, not merely the
 * UI. `src/ai/bundleCost.test.js` asserts the shape that makes the elimination
 * possible, and `bin/verify-ai-bundle.mjs` measures two real builds — 2,362 KB
 * opted out against 11,786 KB with the feature, on 2026-08-15.
 *
 * ── What it does NOT do ──
 *
 * Being on switches on the *offer*, not the download. Nothing is fetched until
 * somebody opens Welly and chooses a model, and a device that cannot run one is
 * never offered one (see `src/ai/capability.js`). A student who never touches the
 * feature downloads nothing beyond the ordinary application: the runtime is its
 * own chunk, and the model is not an asset of this build at all.
 */
export const LOCAL_AI = import.meta.env.VITE_LOCAL_AI === 'true';

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
 * It may be an external URL, or the published policy at `/legal/privacy-policy`,
 * which is where `/privacy` now redirects.
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
 * The built-in privacy notice is gone, and so are the four values it needed.
 *
 * `PRIVACY_CONTACT`, `PRIVACY_RETENTION`, `PRIVACY_UNDER13`, `PRIVACY_OWNER` and
 * `privacyNoticeComplete()` lived here because `PrivacyNotice.jsx` rendered a
 * notice this software could partly write for itself — it knew what the schema
 * collects, and it deliberately refused to invent how long a district keeps
 * records, who a family contacts, or what consent applies below 13. Those four
 * stayed empty and the page announced itself incomplete, which was the right
 * design for a page that had to exist before anybody had answered them.
 *
 * That page was deleted when the published Privacy Policy became the source of
 * truth. `/privacy` redirects to `/legal/privacy-policy`, a hash-pinned document
 * that answers all three in prose a person wrote: the contact address appears
 * eight times in it, the under-13 floor is explicit, and retention has its own
 * table.
 *
 * So the values outlived their only reader. Verified 2026-09-28: nothing in the
 * repository imported any of them — no view, no test — and the launch checklist
 * was still carrying "set these four" as a Phase 0 blocker for a page that could
 * not display them. Removed rather than left, because configuration that looks
 * load-bearing and is not is how somebody later sets a value, sees no effect,
 * and goes looking for the bug in the wrong place.
 *
 * If a self-rendered notice ever returns, take the design back too: empty by
 * default, and loudly incomplete until a human fills it in.
 */

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
 * An absolute URL for a path this application serves — for a link somebody is
 * about to copy or share.
 *
 * ── Why this is separate from `publicOrigin()` ──
 *
 * That one returns a BARE origin with no scheme, because it is printed on paper:
 * "Verify at volunteers.example.org/verify/WEV-…" reads as an address, and a
 * printed `https://` is noise. A link going to the clipboard is the opposite —
 * it has to be a real URL, or half the places somebody pastes it will not
 * linkify it and the other half will guess the scheme.
 *
 * The default is the origin the page is served from, which is correct with no
 * configuration: whoever is copying is already on the right host. `VITE_PUBLIC_URL`
 * overrides it for a deployment whose public address differs from the one the
 * app is reached at internally, and is normalised whether or not it carries a
 * scheme or a trailing slash.
 */
export function publicUrl(path = '/') {
  const configured = import.meta.env.VITE_PUBLIC_URL;
  const raw = configured || (typeof window !== 'undefined' ? window.location.origin : '');
  const trimmed = String(raw).replace(/\/+$/, '');
  /* A configured value may omit the scheme (`publicOrigin()` strips it, and an
     operator who set one for that reason should not have to set a second). */
  const origin = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return `${origin}${String(path).startsWith('/') ? path : `/${path}`}`;
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
/**
 * The domain the platform's own addresses live on. Mirrors `MAIL_DOMAIN` in
 * server/emailIdentity.js — the two have to agree, and each is one line.
 */
export const MAIL_DOMAIN = import.meta.env.VITE_MAIL_DOMAIN || 'wevolunteers.org';

/**
 * The help address, and the first one with a working default.
 *
 * It used to default to the empty string, so the surfaces that check before
 * rendering — About and Settings — simply hid the contact line, while three
 * OTHER places hard-coded a personal Gmail address inline and showed it anyway.
 * A district that set `VITE_SUPPORT_EMAIL` changed the two screens that were
 * already blank and none of the three that were wrong.
 *
 * The platform now has its own addresses, so the default is a real one and the
 * env var narrows to what it was for: a district that wants its own help desk.
 */
export const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || `support@${MAIL_DOMAIN}`;

/**
 * Where somebody contests a decision made about their account.
 *
 * Deliberately NOT the support address. Every screen that names it — the appeal
 * form, the suspended wall — is a person saying "I think this is wrong", which
 * is an adjudication channel and not a help desk. Deliberately not
 * district-overridable either: an appeal is heard by whoever runs the platform.
 */
export const APPEALS_EMAIL = `admin@${MAIL_DOMAIN}`;
export const STUDENT_GUIDE_URL = import.meta.env.VITE_STUDENT_GUIDE_URL || '';
export const ORGANIZER_GUIDE_URL = import.meta.env.VITE_ORGANIZER_GUIDE_URL || '';
