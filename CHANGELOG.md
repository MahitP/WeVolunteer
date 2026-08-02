# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — Unreleased

### Added
- **Content-Security-Policy** — Enabled CSP headers with `script-src 'self'` (no `unsafe-inline` for scripts). `style-src` allows `unsafe-inline` as a bounded concession until inline styles are refactored.
- **Dark mode** — Full dark theme with system-preference detection, manual toggle (light / system / dark), and localStorage persistence. Pre-paint script prevents flash of wrong theme. All design tokens overridden for dark surfaces.
- **Theme toggle** — Segmented control in the topbar for switching between light, system, and dark themes.
- **Server-side logout** — `/api/auth/logout` endpoint that invalidates sessions by clearing the session cookie and incrementing the database `token_version`.
- **Test harness** — jsdom + React Testing Library setup, cookie auth tests, component tests (EventModal, EmptyState, useTheme), hardcoded color linting test.
- **Empty states** — Reusable `EmptyState` component for zero-data scenarios across dashboards, profiles, and modal tabs.
- **Loading skeletons** — `LoadingSkeleton` component for consistent loading states.
- **Email notifications** — Automated email dispatch for critical event workflows (applications accepted/declined/waitlisted, hours awarded, and events cancelled).
- **Email opt-out** — Added a toggle in the user profile to disable email notifications.

### Security
- **Requesting a data export now requires re-verifying your identity** — `POST /api/privacy/export` was the only sensitive endpoint with no step-up at all: an authenticated request plus a rate limit, and a complete copy of everything the account holds became a downloadable file. Deleting the account, changing the password and changing the email address each demanded a credential; the one action that copies every record out — for a population that is mostly minors — demanded nothing, which made it the quietest thing a borrowed or stolen session could do, in a single request, without altering anything the account holder would later notice. It is now behind `requireAAL2('data.export')`, satisfied by the account password **or** by re-authenticating at a linked sign-in provider, and the grant is single-use. The gate is checked before the rate limiter so that an unverified first attempt does not spend the three-per-fifteen-minutes allowance, and the "an export is already in progress" refusal is answered before the verification is consumed, so a user is never asked to verify twice for an export that never started.

### Changed
- **Sensitive actions are gated on step-up re-verification instead of an inline password check** — `DELETE /api/auth/account`, `POST /api/auth/change-password`, `POST /api/auth/change-email` and `POST /api/oauth/link` each performed their own `bcrypt.compare` against the account's stored hash. Individually correct, collectively impossible to reason about: the endpoint that forgot its check looked exactly like the endpoint that never needed one, which is how the data export above went years without a gate. All four now name a registered action from one server-side registry and are gated by `requireAAL2`, and each spends its verification inside the same transaction as the work it authorises — so a verification is bound to one action with its arguments, to one sign-in, for five minutes, and is spendable exactly once. Removing the four inline checks leaves sign-in as the only place in the application that compares a password to decide who someone is. Two user-visible behaviour changes come with it: the `currentPassword` and `password` request fields are gone (the verification is a separate step now), and every one of these actions asks for verification even immediately after signing in.
- **Deleting a provider-only account no longer accepts your own username as the confirmation** — an account that signs in only through Google or Microsoft has no password to re-prove, so deletion asked it to type its own username instead. The code said as much where it did it: *"Typing the account's own username is not a credential."* A username is public within the app and appears on every comment the person has ever posted, so anyone reading over a shoulder — or holding a live session — could supply it. It was the right stopgap while there was no other proof available for such an account; there is one now. Re-authenticating at the provider replaces it. A typed confirmation phrase remains in the interface, where a deliberateness check belongs, but it is no longer what the server accepts as proof.
- **A provider-only account can now set a first password, and connect a second sign-in provider** — neither was possible. `POST /api/auth/change-password` accepted only the current password as proof, which such an account does not have, so it was exempted from proving anything at all; `POST /api/oauth/link` refused it outright with *"that account has no password"*. Both restrictions existed because a password was the only credential these endpoints could check, and both are gone now that re-consent is one: losing access to a single Google account is no longer losing the WeVolunteer account. The guard on `POST /api/oauth/disconnect` that refuses to remove an account's last remaining way to sign in is unchanged, and setting a first password is what releases it.
- **`POST /api/oauth/link` now requires being signed in as the account it links** — it was unauthenticated, tied to an account only by a 15-minute token naming a user id, and proved by that account's password: 600 attempts per window against any address somebody could produce at a provider, which made it a better brute-force target than the login form. It is now authenticated, and refuses a token that names anyone other than the caller. Somebody who reaches the "connect these accounts" prompt while signed out signs in first, then verifies. The endpoint no longer issues a new session on success, which also stops it from replacing a session that supports per-device sign-out and step-up with one that supports neither.
- **Sessions created by signing in with a provider are now per-device revocable** — the OAuth routes minted their own session tokens with a near-copy of the shared function that omitted the per-session id. Everything keyed on that id therefore treated a provider sign-in as second class: signing out of one device did nothing, and no sensitive action could be verified from it at all. One definition now serves both sign-in paths.
- **Attendance confirmation now allows admins** — `POST /api/events/:id/attendance` previously allowed only the hosting organizer to finalize attendance and credit hours, denying admins entirely. Converting the route to the `attendance.mark` capability (part of the ongoing authorization-spine work) corrects this inconsistency: admins may now confirm attendance on any event, matching the access they already had on the related check-in and roster-export routes.
- **Check-in viewing now denies partners** — `GET /api/events/:id/checkin` previously blocked only students by name, so a `partner` account could view an event's check-in roster. Converting the route to the `attendance.view` capability corrects this: it now denies both students and partners, matching the capability table's intent for that role.
- **Closed an unreleased data leak in `GET /api/applications`** — the `partner` role (added to the role enum earlier on this branch, with no users and never released) fell through this route's role-branching into the unscoped "see everything" path, meaning a partner account could have read every application in the system — every student's name and event association — the moment one was created. Fixed before release by capability-scoping the route: `partner` now gets an explicit empty result. Not a behaviour change for any real account, since the role has never shipped.
- **Application status decisions now available to both admin tiers** — `PATCH /api/applications/:id` and `PATCH /api/applications/bulk` previously allowed only the hosting organizer to accept, waitlist, or reject an application: the handler's ownership check (`app.organizer_id !== req.principal.userId`) carried none of the `event.moderate` bypass the other twenty ownership checks on this branch use. `admin` held neither `applicant.review` nor `application.withdraw` and was refused outright; `super_admin` satisfied `applicant.review` through the `'*'` wildcard, entered the organizer branch, and was then denied on every application whose event it did not host — which, for a platform owner who hosts nothing, meant all of them. Neither admin-tier role could correct a mis-set application anywhere on the platform. Both ownership checks now carry the standard `!can(req.principal, 'event.moderate')` bypass, and the route is gated on `requireCapAny(['applicant.review', 'event.moderate', 'application.withdraw'])`. Deliberate behaviour change for `admin`, and the intended behaviour for `super_admin`: a school activities director must be able to correct an application, and a platform owner locked out of application review was the exact defect the authorization-spine work exists to eliminate. No change for `organizer` (unchanged ownership rules), `student` (withdrawal only, on their own row), or `partner` (denied before and after, now at the middleware gate). The authorization matrix row that should have caught this was passing because it used a fake application id with no `status` field, so the request 400'd at validation before the ownership check ran; it now uses a real seeded application and a real body.
- **Organizer statistics now available to admins** — `GET /api/stats/organizer` previously allowed only the requesting organizer's own stats (`role !== 'organizer'` denied everyone else, including admin). Converting the route to the new `analytics.own_events` capability (part of the ongoing authorization-spine work, Task 7d) deliberately grants it to admin too, matching the platform-wide oversight admin already has on `GET /api/applications` and the event roster. Not a behaviour change for organizer or any other existing role.
- **Content, message-search, and profile routes converted to capabilities** (Task 7d, final step of the authorization-spine work) — `contentRoutes.js`, `messageRoutes.js`, `userRoutes.js`, `accountRoutes.js`, and `geocodeRoutes.js` no longer compare `req.user.role` anywhere; every gate now asks `can(req.principal, '<capability>')`. Two new capabilities were added: `stats.self` (a student reading their own volunteer stats) and `analytics.own_events` (see above). `super_admin` — previously blocked on the comment-delete, announcement create/edit/delete, and both stats routes by role-string comparisons that never recognised it — now has the platform-wide access every other admin-tier route already gives it. No behaviour changed for `student`, `organizer`, `admin`, or `partner` on any route except the deliberate `analytics.own_events` widening above; `partner`'s existing (unrestricted) access to `GET /api/geocode` and `GET /api/organizers/:id/profile` was preserved by granting it `geocode.use` and `event.view` respectively, rather than accidentally narrowing it when those routes stopped comparing role strings.
- **Cookie authentication** — Migrated from `localStorage` JWTs in the `Authorization` header to `HttpOnly`, `SameSite=Lax` cookies, reducing XSS exposure.
- **Password minimum length** — Raised from 6 to 8 characters.
- **EventModal refactor** — Extracted `EventApplicantsTab`, `EventAttendance`, `EventEditForm`, `EventShiftsTab`, and `EventAnnouncements` into standalone components.
- **Design tokens** — Replaced ~50 hardcoded colour literals across CSS and JSX with design tokens. Component-specific tokens (topbar, modal overlay, toast, alert, demobar, certificate) now centralized in `:root`.
- **Query invalidation** — Replaced global `refreshAll()` calls with targeted `refreshEvents()` / `refreshApplications()` for better performance.
- **CORS scoping** — CORS middleware moved from global to `/api`-only to prevent static asset blocking.

### Improved
- **Accessibility** — ARIA tablist with roving tabindex on EventModal tabs, skip-to-content link, `role="progressbar"` on hours meter, keyboard navigation on notifications, screen-reader-only text for badge counts, improved mobile touch targets.
- **Mobile layout** — Larger touch targets, improved tap areas, responsive refinements.

## [1.0.0] — 2026-07-27

First production release. The platform is feature-complete for a single-district
pilot: volunteers can find and claim shifts, organizers can staff and confirm
events, and confirmed attendance produces a verifiable service record.

### Added

- **Volunteer experience** — event discovery with search and filters, per-slot
  applications, withdrawal and re-application, personal dashboard with hours
  progress and service history, printable certificates, opt-in leaderboard.
- **Organizer tools** — multi-date sign-up sheet builder, applicant review with
  volunteer history inline, bulk accept/waitlist/decline, announcements, CSV
  roster export, event duplication, mobile day-of check-in.
- **Auto Select** — weighted random selection after the application deadline,
  favouring volunteers with fewer credited hours. Reproducible per-slot seeding,
  stored drafts, a re-draw cap, and a required written reason on every re-draw.
- **Attendance and hours** — check-in separated from hours confirmation, so
  marking someone present during an event credits nothing. Hours are a snapshot
  and are never re-priced. Corrections require a reason and are attributed.
- **Hours ledger** — append-only record of every change to credited hours, with
  actor, source, and reason. Deliberately carries no foreign keys so it survives
  deletion of what it describes.
- **Certificates** — random `WEV-XXXX-XXXX` codes stored server-side, with a
  public verification endpoint that omits the student's grade.
- **Notifications** — in-app notifications for selection results, waitlist
  promotions, hours credited, announcements, and cancellations, plus a
  15-minute sweep for shift reminders, deadline warnings, and an organizer
  alert when a deadline passes with applicants still undecided.
- **Administration** — organizer approval queue, content moderation, reports
  queue, platform statistics.
- **Deployment artifacts** — systemd units for the application and a nightly
  backup timer, a WAL-safe integrity-checked backup script, and environment
  templates for both server runtime and client build configuration.
- **Documentation** — deployment runbook covering provisioning through incident
  response, and a pre-launch readiness review.

### Security

- Hours are derived from confirmed attendance and never stored on a user row,
  so the figure cannot be edited directly.
- Identity is re-read from the database on every request rather than trusted
  from the JWT payload; `token_version` lets a password reset end all sessions.
- Personally identifying information is scoped server-side: contact details,
  grade, and school are visible only to the student, administrators, and
  organizers hosting an event that student applied to. Confirmed future shifts
  are visible only to the student.
- The community leaderboard is opt-in and off by default.
- Startup guards refuse to boot on a missing `JWT_SECRET`, incomplete SMTP
  configuration in production, a missing `APP_URL` in production, or demo mode
  enabled alongside `NODE_ENV=production`.
- Certificate codes are cryptographically random and stored, replacing an
  earlier derivable scheme that could be forged offline.
- Rate limiting on authentication, email-sending endpoints, the public
  certificate-verify endpoint, and the API as a whole.
- Email uniqueness is case-insensitive, with a non-destructive reconciliation
  for pre-existing duplicates.

### Notes

- Requires Node.js 24 or later. The application uses the built-in `node:sqlite`
  module, which is not available on earlier versions without a flag.
- Selection results are delivered in-app only; email notification is on the
  roadmap.
- Rate limiting is in-memory and per-process, so the current design runs a
  single instance.
