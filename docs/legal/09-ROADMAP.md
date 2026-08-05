# WeVolunteer — definitive implementation roadmap

**Date:** 2026-08-05 · **Baseline:** 156 test files, 2517 tests passing; lint, build, migration
checksums and document hashes clean. Migrations 001–009 registered.

This is the execution plan from the current state to a defensible public launch. Every item is
a single pull request that leaves `main` in a working, shippable state. Nothing here is
implemented.

---

## Part 1 — Audit findings

### 1.1 Live defects

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **D-1** | **`/legal/terms` and `/legal/guidelines` are linked from the signup consent block and neither route exists.** Both 404. | **Critical** | `src/views/Signup.jsx` emits both; `src/routes/index.jsx` declares neither |
| D-2 | `[[DISTRICT_NAME]]` survives in the handoff doc — a Posture A leftover | Trivial | `docs/legal/04-DEVELOPER-HANDOFF.md:273` |

D-1 is mine, introduced in the consent work. A broken link in a consent flow is the worst
placement possible: it is the one moment the user is being asked to rely on a document, and the
document is not there. It is also an FTC §5 problem in miniature — "read the Terms" pointing at
nothing is a misrepresentation about the availability of the terms.

### 1.2 Reporting — corrected

I previously said reporting "covers conversations only." **That is wrong.** Actual state:

| Target | Status | Where |
|---|---|---|
| Conversation | ✅ | `conversation_reports` + `POST /api/messages/conversations/:id/report` |
| Event | ✅ | `reports` (`target_type` CHECK) + `POST /api/reports` |
| Comment | ✅ | same |
| **User** | ❌ | not a permitted `target_type` |
| **Organizer** | ❌ | — |
| **Individual message** | ❌ | only whole conversations |
| **Certificate abuse** | ❌ | — |
| **Impersonation** | ❌ | — |

The admin queue (`GET/PATCH /api/admin/reports`) handles the two existing types. It has
`status` only — no priority, assignment, notes, or resolution history.

### 1.3 Dead or reserved capabilities

Registered in `authz.js`, referenced by no route:

| Capability | Verdict |
|---|---|
| `self.write` | **Dead.** Profile writes are SELF_ONLY via the registry, not this gate. Remove or wire |
| `attendance.scan`, `qr.present` | **Reserved.** QR check-in is designed, not built |
| `analytics.platform` | **Reserved.** SUPER_ONLY, no route |
| `impersonation.start` | **Reserved for v2.0.** Must not ship without its own policy |
| `error.raed` | **Intentional.** A deliberate typo asserted by `authz.test.js` |

Not urgent, but a capability nothing enforces is a false signal in an authorization table that
is otherwise exact.

### 1.4 Unbuilt features referenced by documents

| Feature | Referenced in | Marker |
|---|---|---|
| Certificate void at deletion | Deletion Policy, Certificate Policy | `[[NOT YET IMPLEMENTED]]` |
| Message redaction | Youth Safety ("still not built") | Prose |
| Reporting beyond conversation/event/comment | Youth Safety | Prose |

These are honestly marked. They are the only remaining places a document describes something
absent, and each must be either built or the sentence deleted before publication.

### 1.5 Blocked on external inputs

`[[LEGAL_ENTITY_NAME]]` ×4 · `[[OWNER]]` ×5 · `[[POSTAL_ADDRESS]]` · `[[VENUE_COUNTY]]` ·
`[[LIABILITY_CAP]]` · `[[SMTP_PROVIDER]]` · `[[HOSTING_PROVIDER]]` · `[[HOURS]]` (safety inbox
monitored hours) · `[[APPROVER]]` (admin register owner).

**None of these are engineering work.** They are entity formation, vendor selection, and two
operational decisions. They gate publication, not development — which is why document
publication is the last PR, not the first.

### 1.6 Security assumptions worth stating

| Assumption | Holds? | Note |
|---|---|---|
| Every capability is re-checked server-side | ✅ | Six build-failing guards |
| Sensitive actions require step-up | ✅ | All seven registered actions gated and spent |
| Suspension ends live sessions | ✅ | `token_version` bump, tested |
| Consent cannot be bypassed | ✅ | All three creation paths gated |
| Audit log is tamper-evident | ❌ | **No integrity protection.** An admin with DB access can rewrite the record of their own actions |
| Blocking cannot be griefed | ⚠️ | No rate limit on `POST /api/blocks/:userId` |
| `localStorage` is safe on shared devices | ⚠️ | Caches name/username/role; disclosed, not fixed |

---

## Part 2 — The pull requests

Ordered so each merge leaves `main` shippable. Complexity: **XS** <½d · **S** ~1d · **M** 2–4d ·
**L** 1–2w.

---

### PR-0 — Hotfix: make the signup legal links resolve

**Objective.** Stop shipping two 404s inside the consent block. Smallest change that makes the
links honest; the real Legal Center is PR-4.

**Affected files.** `src/routes/index.jsx`, `src/App.jsx` (PUBLIC_ROUTES), `src/views/Signup.jsx`.

**Migrations.** None. **Routes.** None (server).

**Frontend pages.** Either (a) point both links at `/privacy` with accurate labels, or
(b) add minimal `/legal/terms` and `/legal/guidelines` views rendering the published text.
**Recommend (a)** — it is a one-line honesty fix and does not pre-empt PR-4's design.

**Tests.** Extend `App.routeTable.test.jsx`: every internal `href` emitted under `src/` resolves
to a declared route or a public path. Derive from the route table, do not restate it.

**Acceptance criteria.**
- No link rendered anywhere in `src/` points at an undeclared internal path.
- The consent block's links open something real, signed out.
- A build-failing test prevents recurrence.

**Complexity.** XS. **Dependencies.** None. **Rollout risk.** None — strictly reduces breakage.

> Ship this today, independent of everything else.

---

### PR-1 — Organizer Agreement acceptance

**Objective.** Make the Organizer Agreement bind somebody. Closes R-04, the oldest unaddressed
RED finding: adults receive minors' contact details under no recorded undertaking.

**Affected files.** `server/migrations/010_organizer_agreements.js`, `server/legalDocuments.js`
(register the agreement), `server/consent.js` (reuse `recordAcceptances`),
`server/routes/adminRoutes.js` (`organizer.approve`), `server/routes/accountRoutes.js`,
`src/views/OrganizerOnboarding.jsx` (new), `src/routes/index.jsx`.

**Migrations.** `010_organizer_agreements` — or reuse `legal_acceptances` with a new document
slug. **Prefer reuse:** the table already carries version, hash, method, and context, and a
second near-identical table would drift. Add `organizer-agreement` to the registry with
`consentType: 'agree'` and a `scope: 'organizer'` marker so it is not demanded at signup.

**Routes.** `GET /api/legal/organizer-agreement` (current version + acceptance state) ·
`POST /api/legal/organizer-agreement/accept`.

**Frontend.** Post-approval interstitial: full text, seven itemised checkboxes (already drafted
in policy 09 §13), accept/decline. Declining leaves a normal account.

**Tests.** `organizer.approve` cannot complete the transition to organizer capabilities without
an acceptance row at the current version · acceptance recorded transactionally · re-approval
after a version bump requires re-acceptance · a declining user keeps a working non-organizer
account · itemised checkboxes all required.

**Acceptance criteria.**
- No account holds `event.create` / `applicant.review` without a current acceptance row.
- Acceptance names the version and content hash.
- An admin approving someone does not by itself grant capabilities — the organizer's own
  acceptance completes it.

**Complexity.** M. **Dependencies.** None (consent infrastructure exists).

**Rollout risks.** **Existing approved organizers have no acceptance row.** Choose deliberately:
grandfather them with a banner and a deadline, or pause their capabilities immediately.
**Recommend grandfathering with a 14-day deadline** — pausing live organizers mid-event strands
students, which is the same reasoning that made suspension report active events rather than
cancel them.

---

### PR-2 — Guardian consent capture

**Objective.** Restore the enforceability the district used to provide. A minor's assent is
voidable; with no district agreement, a verified guardian acknowledgement is the only mechanism
left.

**Affected files.** `server/migrations/011_guardian_consents.js`, `server/guardianConsent.js`
(new), `server/routes/authRoutes.js`, `server/email.js`, `src/views/Signup.jsx`,
`src/views/GuardianConfirm.jsx` (new).

**Migrations.** `011_guardian_consents` — `user_id`, `guardian_email`, `token_hash`,
`confirmed_at`, `created_at`, `expires_at`, `revoked_at`. Unique partial index on active rows.
Token hashed, matching every other token in this codebase.

**Routes.** `POST /api/auth/guardian/resend` · `GET /api/auth/guardian/confirm/:token` (public) ·
`GET /api/auth/guardian/status`.

**Frontend.** Guardian email field in the signup consent block, shown when `date_of_birth`
implies under 18 (the age gate already collects it). Public confirmation page.

**Tests.** Under-18 signup without a guardian email is refused server-side · token is
single-use and expires · confirmation records `confirmed_at` · an 18+ signup does not ask ·
the guardian address may not equal the student's · resend is rate-limited.

**Acceptance criteria.**
- No under-18 account is created without a guardian email recorded.
- The confirmation link works exactly once.
- Guardian receives: account created, suspension, safety report involving their student,
  deletion.

**Complexity.** L. **Dependencies.** Age gate (shipped).

**Rollout risks.** Signup friction and students entering a friend's address — imperfect and
still far better than nothing. **Decide before building:** does an unconfirmed guardian email
block the account, or only warn? Recommend warn-then-restrict after 14 days; a hard block at
signup will be defeated by fake addresses and teaches nothing.

---

### PR-3 — Report target expansion

**Objective.** Let a student report a person, not just a place. Today they can report an event,
a comment, or a whole conversation — not the user, the organizer, a single message, a forged
certificate, or an impersonation.

**Affected files.** `server/migrations/012_report_targets.js`, `server/routes/contentRoutes.js`,
`server/routes/adminRoutes.js`, `src/components/ReportModal.jsx`.

**Migrations.** `012_report_targets` — **table rebuild**, because `reports.target_type` has a
CHECK constraint and SQLite cannot alter one. This is structural: follow all six guards in
ENGINEERING_GUIDE §8.3 (backup, pragma assertion, explicit column list, unknown-column guard,
child-row count comparison, `foreign_key_check`). Copy `001_authz_roles.js`'s structure. Add
`category` and `priority` while rebuilding — doing it once is cheaper than twice.

**Routes.** Extend `POST /api/reports`. New: `POST /api/messages/:id/report` (single message).

**Frontend.** One `<ReportModal>` handling every target type, with the category list written
from the Youth Safety Guidelines in students' words ("someone asked me for personal
information", "trying to move the conversation somewhere else").

**Tests.** Migration idempotency and the §8.3 guards · every target type accepted and scoped ·
a reporter cannot report themselves · reporting an invalid target 404s without leaking
existence · rate-limited.

**Acceptance criteria.** Every surface named in the Youth Safety Guidelines is reportable, and
the Guidelines no longer say otherwise.

**Complexity.** M. **Dependencies.** None. **Rollout risk.** Table rebuild — the one genuinely
destructive migration shape. Rehearse against a copy of production first.

---

### PR-4 — Legal Center

**Objective.** Make the documents reachable in the product. They exist in `docs/`; users cannot
read them. Supersedes PR-0's stopgap.

**Affected files.** `src/index.css` (tokens per `02-DESIGN-SYSTEM.md` §2.1), `src/views/legal/*`
(new), `src/components/legal/*` (new), `src/routes/index.jsx`, `server/routes/legalRoutes.js`
(serve document content + version metadata).

**Migrations.** None.

**Routes.** `GET /api/legal/documents` · `GET /api/legal/documents/:slug` ·
`GET /api/legal/documents/:slug/:version`.

**Frontend pages.** `/legal` hub · `/legal/:slug` per document · `/legal/changes` changelog ·
`/legal/v/:slug/:version` archive. All public. `LegalLayout`, `Callout`, `TableOfContents`,
`PolicyMeta`, `AnchorHeading`, `ContactCard`, `PolicyTable` — specified in
`04-DEVELOPER-HANDOFF.md` §3.

**Tests.** Token guards pass (`tokens.test.js`, `noHardcodedColors.test.js`,
`noDanglingClasses.test.js`) · every legal route renders signed out, derived from
`PUBLIC_ROUTES` · TOC builds from rendered `h2[id]` and moves focus on activation · callouts
render their visible label for every tone.

**Acceptance criteria.**
- Every published document is readable in-app, signed out, on mobile, in both themes.
- Version and effective date shown on every document.
- No link anywhere in `src/` 404s.

**Complexity.** L. **Dependencies.** PR-0 (removes the stopgap).

**Rollout risks.** Touches `index.css`, which every screen reads. Ship tokens and CSS in the
first commit, components second — the handoff spec's implementation order exists for this.

---

### PR-5 — Moderation queue backend

**Objective.** Turn the report list into a workflow. Today it has `status` and nothing else.

**Affected files.** `server/migrations/013_moderation_workflow.js`,
`server/routes/adminRoutes.js`, `server/moderation.js` (new).

**Migrations.** `013_moderation_workflow` — additive: `assigned_to`, `priority`,
`resolution_note`, `resolved_by`, `resolved_at` on `reports`; new `moderation_actions` table
(report_id, actor, action, note, created_at) for resolution history.

**Routes.** `GET /api/admin/reports` with filter/sort/search/pagination ·
`PATCH /api/admin/reports/:id` (assign, prioritise, resolve) ·
`POST /api/admin/reports/:id/notes` · `GET /api/admin/reports/:id/history`.

**Tests.** Every mutation audited · assignment is visible to other moderators · resolution
requires a note · history is append-only · `report.resolve` gates all of it · a resolved report
cannot be silently reopened without a history row.

**Acceptance criteria.** A moderator can answer "what is open, who owns it, what happened, why"
without reading the database.

**Complexity.** M. **Dependencies.** PR-3 (share one rebuild if sequenced together — consider
merging PR-3 and PR-5's migrations to avoid two rebuilds of `reports`).

---

### PR-6 — Moderator dashboard

**Objective.** The UI for PR-5, sized for a two-person team rather than a moderation department.

**Affected files.** `src/views/Moderation/*` (new), `src/routes/index.jsx`, `src/App.jsx` (NAV
entry with `requiredCap: 'report.resolve'`).

**Frontend.** Queue with filters (status, priority, category, assignee), detail view with the
preserved evidence, action bar (warn / remove content / suspend / dismiss), notes, history.

**Tests.** Route hidden without `report.resolve` · queue filters and sorts · actions write audit
rows · keyboard navigable · evidence renders without executing user content.

**Acceptance criteria.** One person can triage a day's reports without leaving the page. Every
action is audited. Run `/design-critique` and `/accessibility-review` before merge.

**Complexity.** L. **Dependencies.** PR-5, PR-4 (design system).

**Rollout risk.** This surface displays user-generated content to staff — the one place stored
XSS would land on a privileged session. Render as text, never `dangerouslySetInnerHTML`.

---

### PR-7 — Message redaction and evidence preservation

**Objective.** Let a moderator remove abusive content without destroying the evidence that it
existed.

**Affected files.** `server/migrations/014_message_redaction.js`, `server/messaging.js`,
`server/routes/messageRoutes.js`, `src/views/Messages.jsx`.

**Migrations.** Additive: `redacted_at`, `redacted_by` on `messages`. Body preserved; display
suppressed. A tombstone, never a delete — the retention sweep already exempts reported
messages, and this must not become a second path that destroys them.

**Routes.** `POST /api/admin/messages/:id/redact` · `POST /api/admin/messages/:id/unredact`.

**Tests.** A redacted message renders as removed to participants and in full to `report.resolve`
holders · redaction is audited · the retention sweep still exempts it · unredaction restores.

**Acceptance criteria.** Removing content and preserving evidence are the same operation.

**Complexity.** M. **Dependencies.** PR-5.

---

### PR-8 — Appeals

**Objective.** Make the appeal promised in the Community Guidelines real. Today it is an inbox.

**Affected files.** `server/migrations/015_appeals.js`, `server/routes/appealRoutes.js` (new),
`src/views/Appeal.jsx` (new), `src/views/Moderation/*`.

**Migrations.** `appeals` — user_id, subject (suspension / removal / report outcome), statement,
status, reviewer_id, decision, reasoning, created_at, decided_at.

**Routes.** `POST /api/appeals` (suspended users must be able to reach this — add to the
`EMAIL_GATE_ALLOWLIST` equivalent for suspended accounts, or accept unauthenticated with a
signed token from the suspension email) · `GET /api/appeals/mine` ·
`GET/PATCH /api/admin/appeals/:id`.

**Tests.** **A suspended user can file an appeal** — the case that breaks if appeals sit behind
`authenticateToken`, which refuses suspended accounts with 403 · a decision requires reasoning ·
history preserved · the appellant is told the outcome.

**Acceptance criteria.** Every enforcement action has a route to challenge it, and the
Guidelines' stated 5-business-day commitment is operable.

**Complexity.** M. **Dependencies.** PR-5.

**Rollout risk.** The reachability problem above is the whole difficulty. Design it first.

---

### PR-9 — Re-consent middleware and read-only mode

**Objective.** Make document versioning operational. Today a MAJOR bump would change nothing for
existing users.

**Affected files.** `server/consentGate.js` (new), `server/app.js`, `server/utils.js`,
`src/components/ReconsentInterstitial.jsx` (new), `src/session/SessionProvider.jsx`.

**Migrations.** None — `legal_acceptances` already records versions.

**Routes.** Middleware over authenticated routes, mirroring `isEmailGateAllowed`'s allowlist
pattern (proven in this codebase). `POST /api/legal/reconsent`.

**Tests.** A user on an outdated MAJOR version is gated · the allowlist permits sign-in, export,
deletion, and the reconsent endpoint · a MINOR bump gates nobody · the 14-day grace expires into
read-only · **read-only still permits export and deletion** — the guarantee that keeps declining
from being a trap.

**Acceptance criteria.** Declining new Terms never costs a user access to their own record.

**Complexity.** M. **Dependencies.** PR-4 (users must be able to read what changed).

---

### PR-10 — Privacy request workflow

**Objective.** Make the Privacy Policy's stated commitments — 10 business days to acknowledge,
45 to resolve — operable rather than aspirational.

**Affected files.** `server/migrations/016_privacy_requests.js`,
`server/routes/privacyRoutes.js`, `src/views/Settings/PrivacyRequests.jsx`,
`src/views/legal/RequestForm.jsx`.

**Migrations.** `privacy_requests` — requester, type (access / correction / deletion / question),
subject_user_id, status, received_at, acknowledged_at, resolved_at, notes. Guardian requests
carry a verified-relationship flag.

**Routes.** `POST /api/privacy/requests` (authenticated and public — guardians have no account) ·
`GET /api/privacy/requests/mine` · admin queue under `audit.read`.

**Frontend.** "Your agreements" in Settings (specified in `07-CONSENT-SYSTEM.md` §5) showing
accepted versions with links to the exact archived text, plus a request form.

**Tests.** SLA timestamps recorded · a guardian request requires verification before disclosure ·
status visible to the requester · every access to a subject's data is audited.

**Acceptance criteria.** A parent can ask a question and see it was received. Nothing relies on
someone remembering to check an inbox.

**Complexity.** M. **Dependencies.** PR-4.

---

### PR-11 — Certificate void at deletion

**Objective.** Close R-02's remaining half. Retention is decided (indefinite); the missing piece
is the student's choice.

**Affected files.** `server/routes/accountRoutes.js`, `server/certificates.js`,
`server/routes/attendanceRoutes.js`, `src/components/account/DeleteAccountModal.jsx`.

**Migrations.** Additive: `voided_at` on `certificates`.

**Routes.** Extend `DELETE /api/auth/account` with a `certificates: 'keep' | 'void'` parameter —
**bound into the step-up challenge params**, so the choice cannot be swapped after verification.

**Tests.** Voiding sets the anonymised name and marks the certificate revoked · verification of a
voided certificate returns "withdrawn", not "invalid" · keeping preserves current behaviour ·
the choice is bound to the grant.

**Acceptance criteria.** A student trades verifiability for erasure knowingly, and the Deletion
and Certificate policies drop their `[[NOT YET IMPLEMENTED]]` markers.

**Complexity.** S. **Dependencies.** None.

---

### PR-12 — Security hardening

**Objective.** The three assumptions in §1.6 that do not hold.

**Affected files.** `server/auditLog.js`, `server/routes/messageRoutes.js`, `server/app.js`,
`src/utils/api.js`.

**Migrations.** Additive: `prev_hash`, `entry_hash` on `admin_audit_logs` for a hash chain.

**Scope.**
- **Audit integrity.** Hash-chain each entry over the previous. Does not stop a determined
  admin with DB access, but makes tampering detectable — which is the achievable bar.
- **Rate-limit blocking.** `POST /api/blocks/:userId` has none; it is cheap to grief.
- **`localStorage` cache.** Move to `sessionStorage` or drop it. It caches name, username and
  role on shared school Chromebooks.

**Tests.** A modified audit row fails chain verification · block rate limit · no account details
persist after tab close.

**Complexity.** M. **Dependencies.** None.

---

### PR-13 — Dead capability cleanup

**Objective.** An authorization table that is exact everywhere except five entries is less
trustworthy than one that is exact.

**Affected files.** `server/authz.js`, `server/authz.test.js`, `server/userCapabilities.js`.

**Scope.** Remove `self.write` (genuinely dead). Annotate `attendance.scan`, `qr.present`,
`analytics.platform`, `impersonation.start` as reserved, with the release that will use them.
Leave `error.raed` — it is an intentional guard.

**Tests.** Existing `authz.completeness.test.js` guards cover it. Add: every registered
capability is either used by a route or carries a reserved-with-reason annotation.

**Complexity.** XS. **Dependencies.** None.

---

### PR-14 — Accessibility pass on everything new

**Objective.** WCAG 2.1 AA across the Legal Center, moderator dashboard, consent interstitial,
appeal form, and report modal.

**Affected files.** All new views from PR-4, PR-6, PR-8, PR-9, PR-10.

**Scope.** Run `/accessibility-review`. Keyboard paths, focus management in dialogs, contrast
recomputed from tokens (`inputContrast.test.js` is the pattern), heading order, `aria-live` for
async results, 44×44 touch targets, `prefers-reduced-motion`, 400% zoom.

**Tests.** Extend `inputContrast.test.js` to any new token pair. Dialog focus-trap and
restoration tests.

**Acceptance criteria.** No new AA failure. **Then** run VoiceOver and NVDA manually — static
review catches ~30% and a conformance claim made on it alone is its own liability.

**Complexity.** M. **Dependencies.** PR-4, PR-6, PR-8, PR-9, PR-10.

---

### PR-15 — Entity, publication, and launch checklist

**Objective.** Fill every `[[BRACKETED]]` value and publish. **Not engineering work** — it is
gated on entity formation and counsel.

**Affected files.** All of `docs/legal/policies/`, `server/legalDocuments.js` (v2.0 bumps),
`.env` templates.

**Scope.**
- LLC formed; `[[LEGAL_ENTITY_NAME]]`, `[[POSTAL_ADDRESS]]`, `[[VENUE_COUNTY]]`,
  `[[LIABILITY_CAP]]` resolved.
- Terms of Service **drafted by counsel**, not reviewed.
- Counsel review of the mandated-reporter wording in Youth Safety.
- `[[HOURS]]` (safety inbox monitored hours) and `[[APPROVER]]` (admin register owner) decided.
- Institutional `privacy@` address replacing the Gmail.
- Version bump to 2.0 across the set — MAJOR, because a change of legal entity is a change of
  counterparty and every user must re-accept. **PR-9 must ship before this.**

**Complexity.** S engineering, weeks of calendar. **Dependencies.** PR-9. External: counsel,
entity formation.

**Rollout risk.** The re-consent wave will hit every existing user at once. Stage the effective
date 30 days out and confirm the interstitial and grace period behave under load.

---

## Part 3 — Sequencing

```
Week 1     PR-0  hotfix (ship immediately, standalone)
Weeks 1–2  PR-1  organizer agreement      ─┐ legal blockers,
Weeks 2–4  PR-2  guardian consent         ─┘ parallelisable
Weeks 3–4  PR-3  report targets           ─┐
Weeks 4–5  PR-5  moderation backend       ─┤ T&S chain,
Weeks 5–7  PR-6  moderator dashboard      ─┤ strictly ordered
Week  7    PR-7  redaction                ─┤
Weeks 7–8  PR-8  appeals                  ─┘
Weeks 4–6  PR-4  Legal Center             ─── parallel with T&S
Week  9    PR-9  re-consent middleware
Week  10   PR-10 privacy requests
Week  10   PR-11 certificate void          ─┐ small, fill gaps
Week  11   PR-12 security hardening        ─┤
Week  11   PR-13 capability cleanup        ─┘
Week  12   PR-14 accessibility pass
Ongoing    PR-15 entity + publication (external critical path — start week 1)
```

**Roughly 12 weeks with two engineers**, assuming PR-15's legal track runs in parallel from day
one. It is the longest pole and the least controllable, so start it before any code.

### The minimum viable closed pilot

If the goal is one school, ~50 students, organizers personally known, and someone reading every
report: **PR-0, PR-1, PR-3, PR-4, PR-11**. Roughly four weeks. That is defensible for a
supervised pilot and is not defensible for public launch, because it has no moderation workflow,
no appeals, and no guardian consent.

### Merge rules

Each PR must pass all four gates (`npm ci`, `npm test`, `npm run build`, `npm run lint`) plus
`node bin/legal-hashes.mjs` and `node bin/migration-checksums.mjs`. Any PR touching a published
document bumps its version and records the MAJOR/MINOR classification with reasoning. Any PR
adding a route adds its `ROUTE_REGISTRY` entry in the same commit. Expect to re-anchor
`authz.completeness.test.js` line references after edits to `authRoutes.js`, `oauthRoutes.js`,
or `Signup.jsx` — the guard catches it every time, which is the design working.
