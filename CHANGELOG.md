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

### Changed
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
