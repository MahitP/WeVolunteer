# WeVolunteer — Final Requirements Audit

**Started:** 2026-09-30
**Baseline commit:** `b49ec35` (local `main`, level with `origin/main`)
**Source of requirements:** [`2026-10-owner-request-history.md`](2026-10-owner-request-history.md) — the owner's own request history, verbatim
**Predecessor:** [`2026-09-21-full-system-audit.md`](2026-09-21-full-system-audit.md)

**The question:** is WeVolunteer the product its owner asked for? Specifically:
was every requested feature added, is every reported issue actually fixed, was
anything missed, and — the one the owner called most important — is the app the
product he imagined?

This is a living document. Phases append to it; nothing is rewritten after the
fact except status columns, and every status change names its evidence.

---

## Why this audit exists when the last one closed

The 2026-09-21 audit asked the same question and closed with one item
**UNRESOLVED** for its entire run: §57 / P0-2, "the referenced historical
product material was not supplied". It built its ledger from repository history
instead, and recorded — correctly — that a repository can say *what was built*
but not *what was asked for*.

The owner has now supplied that material. This audit folds it in as the
authoritative source and reopens anything it contradicts.

### A correction to the predecessor's record

The 09-21 audit's **Pass 15** is headed "the six owner decisions, answered and
implemented", and its body says they were *"answered on repository evidence
during this audit, not deferred"*. They were chosen by the audit, not by the
owner — no conversation with the owner is cited for any of them. The heading
reads as the owner's word; it was not.

Consequence: where the owner's history contradicts a Pass 15 choice, the
history wins. Of the nine, one contradicts it directly:

| Pass 15 choice | Owner's words | Result |
|---|---|---|
| **6A** — Calendar is "direct-access, not promoted" for administrators | FX-12: the admin bar should be "Dashboard, Opportunities, **Calendar**, Messages, Admin" | Reopened; on the decision gate |
| **1A** — permanent lock after close-out | LG-08: "if they finalize it and then closes the event u can't unchange it but if u … didn't close the event (yet) u can still change them" | Agrees. Kept |

The other seven concern cancelled events, milestones and badge-loss auditing,
which the history does not address. They stand.

---

## Method

### Evidence standard (inherited unchanged)

Every status cites a file and line, a commit, a command that was run, or a
screenshot. Two grades:

- **Reported** — surfaced by a triage pass or an intake claim, not yet
  confirmed by reading the code path end to end. **Never acted on.**
- **Verified** — the path was read client affordance → API → server rule →
  persistence; where a test claims to cover it, the behaviour was reverted and
  the test watched to fail.

A test name, a commit message, or a previous audit's conclusion is not evidence.

### Statuses

| Status | Meaning |
|---|---|
| **Done** | Built as asked |
| **Done-Differently** | Built another way on purpose; the recorded reason is cited. **The owner rules on every one** (decision gate) |
| **Partial** | Some of the request is missing |
| **Missing** | Not built |
| **Regressed** | Was done, is broken again |
| **Superseded** | A later request replaced it |
| **Deferred** | Owner decided to postpone |
| **Owner-action** | Outside the codebase — accounts, DNS, credentials, legal sign-off |
| **Dup** | Repeats an earlier request; tracked there |

Each status carries its grade: `Done·R` is Reported, `Done·V` is Verified.

### Ground rules

- **Real data is never touched.** `pilot.db`, its backups, and production hold
  real minors' records. All runtime work uses a throwaway database at an
  absolute `WEV_DB_PATH` in a scratch directory.
- **Security gate:** any change to authentication, authorization, 2FA,
  sessions or secrets passes the `security-review` skill before it counts
  (ENGINEERING_GUIDE §3.2).
- **Menu-bar restraint** (FX-15, the owner's standing rule): no new top-level
  navigation entries.
- **Deletions, production writes, DNS, deploys and credentials are the
  owner's.** This audit lists them; it does not perform them.

---

## Owner decisions — 2026-09-30

Taken at planning, in answer to four questions.

1. **The @mahit showcase (FX-55, FX-60): "put it all on my real account."**
   Implemented as a **demonstration record**: seeded rows carry a marker; the
   profile shows every badge, achievement, hour and streak with a small
   "demonstration record" tag; marked rows are excluded from the transcript,
   certificates, `/verify`, and every public or impact total. The seed runs
   through the real attendance and hours-ledger path, and the owner — not this
   audit — runs it against production.
   *Why the marker:* unmarked, the rows would place hours that were never served
   on a verifiable record the owner intends to show colleges (FX-22: "he could
   still show his hours and stuff to colleges"), and would inflate the published
   platform totals, every one of which binds the owner personally under
   Posture B. The marker keeps the look he asked for without making the record
   false.
2. **Deliberate deviations: "ask me about each one first."** Nothing built
   differently on purpose is changed until the owner rules on it. Phase 1 ends
   with the **decision gate** below.
3. **Message attachments (P2-50): deferred until after launch.**
4. **Frontend revamp (FE-01): a separate engagement after this audit**, run in
   Claude Design once the owner supplies the colour-scale photos and the
   "Launching a Vibe-Coded App" checklist. This audit hands over; it does not
   redesign.

### Acknowledged: the roadmap is not the blueprint

The history ends with a service list (Vercel, Supabase, Clerk, Stripe, …). The
owner said plainly that it is not a strict blueprint and that hosting moved off
Vercel. What actually runs:

| Roadmap said | Reality | Why |
|---|---|---|
| Vercel | Oracle VM, systemd, nginx, Cloudflare in front; scripted build/swap/rollback | The server is one long-running process with in-process workers and a socket server; serverless cannot host it |
| Supabase | SQLite live; PostgreSQL (Supabase-hosted) implemented, boot-tested, not cut over | The cutover is an owner decision |
| Clerk | In-house auth: JWT cookies, bcrypt, TOTP / email / recovery-code 2FA, Google and Microsoft OAuth | — |
| Stripe | Not built | SC-05: owner deferred donations to after launch |
| Resend, Cloudflare, Amplitude, Better Stack, Upstash, Pinecone, GitHub | In use | — |

---

## Phase 0 — Baseline

| Fact | Value |
|---|---|
| Commit | `b49ec35`, working tree clean, 0 ahead / 0 behind `origin/main` |
| `npm test` | **676 files (665 passed, 11 skipped); 11,123 tests passed, 178 skipped, 0 failed**; 112 s; exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| Commits since the 09-21 baseline `45a2230` | 111 |
| Source files changed since then | 175 in `src/` and `server/` |
| Migrations | 71 (latest `071_resync_cookie_notice_cloudflare`) |

This is the regression floor for the engagement. Any later run below it is a
regression introduced by this work until shown otherwise.

**Commit identity (P2-44):** 1,015 of 1,038 commits are authored with the
`users.noreply.github.com` address GitHub links to the owner's profile, and
that is the configured identity. The 23 older commits used the plain Gmail
address. Resolved; nothing to change.

---

## The requirements ledger

IDs follow the history's own sections in the order the owner wrote them:
`FX` "Issues fixed", `CK` "Issues to check", `EM` email, `P2` the Phase 2 feature
list, `LG` legal and event-form items, `SC` scaling / Owner Center / final
passes, `FE` frontend, SEO and domains. Evidence is from the planning triage and
is **Reported** until Phase 1 promotes it.

### FX — "Issues fixed" (75)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| FX-01 | 403 screen full-screen like 404/500; all error screens match, mobile + laptop | Done·V | `src/App.jsx:1939-1941`; `ErrorExperience/kinds.js` (`403: 'immersive'`) | Visual check in Phase 2 incl. landscape phone — **Final:** browser, Phase 2 |
| FX-02 | Admin audit log styled properly | Done·V | `AdminAuditExplorer.jsx:213-243`; `index.css:9171`; `16b9867` | Sentences, severity, cards on mobile — **Final:** browser, Phase 2 |
| FX-03 | Suspension splash: red border, blurred app behind, unescapable, reason shown, can sign out, no global sign-out | Done·V | `App.jsx:~1662-1681` ("reverted, for three reasons"); `SuspendedWall.jsx`; `authRoutes.js:1678-1695` | Reason + per-device sign-out done. Blur deliberately reverted; no red border. **Gate** — Ruling 1: red border over static blurred backdrop — **Final:** `17e6b86` (ruling 1) |
| FX-04 | "New message" copy wrong for admins/organizers | Done·V | `components/messages/recipientCopy.js:60,87,122` | Copy derived from capabilities — **Final:** browser, Phase 5 walk after `b8a3e92` (the copy fell to "not available" without a cached user) |
| FX-05 | One Admin / SuperAdmin entry instead of many | Done·V | `App.jsx:433` | Single "Admin" → `/admin/moderation` — P1: NAV table read: one Admin entry |
| FX-06 | "Create event" on the right of Opportunities for everyone who can; remove "New Event" from nav | Done·V | `BrowseEvents.jsx:593,691-694`; `App.jsx:397` | P1: NAV comment + Discover header |
| FX-07 | Owner pages only via the hub, never deleted: Community Impact, Appeals, Admin Roster, Audit Explorer, Errors, Platform Impact | Done·V | `ModerationCenter.jsx:77-140`; routes intact | Tile names ≠ page titles (see A10) — P1: all six routes registered; hub tiles present |
| FX-08 | Mahit persona switch: owner / admin / organizer / student | Done·V | `server/routes/personaRoutes.js:79-82`; `PersonaPreviewBanner.jsx:39` | — **Final:** browser, Phase 6 owner walk: preview as student lands on the dashboard with its banner; Stop returns |
| FX-09 | Mahit's handle is `@mahit`; delete any conflicting account; only two accounts matter | Done·V | `bin/bootstrap-owners.mjs:77-78`; `server/config.js:414`; `accountValidation.js:119-137` | Nothing guarantees `@mahit`. **Deletion is Owner-action** — production holds real users; this audit deletes no accounts — **Final:** `152aab1` reserves @mahit; any conflicting production account is an Owner-action |
| FX-10 | WeVolunteer platform account gets a special owner profile | Done·V | `App.jsx:184-189,215-218`; `profileSerializer.js:115,143` | Keyed on role, so both super_admins get the same treatment — **Final:** `152aab1`, `6a4c6c2` (rulings 19, 21) |
| FX-11 | "Your next shift" too bright in dark mode; match other greens | Done·V | `index.css:433,466,2208` | Eyeball in Phase 2 — **Final:** browser, Phase 2 |
| FX-12 | Admin mobile bar: Dashboard, Opportunities, Calendar, Messages, Admin; overflow: Notifications, My profile; short consistent hub name; no detached separator | Done·V | `App.jsx:392,2251-2345`; 09-21 Pass 15 6A | No Calendar — an audit choice, not the owner's. **Gate** — Ruling 2: add Calendar for admins (6A overturned) — **Final:** `a339315`, `fa5cb5e` (ruling 2) |
| FX-13 | Owner/partner preview selector UI cleaner | Done·V | `ModerationCenter.jsx:388,423-448` | Radio cards replaced `<select>` — **Final:** browser, Phase 6 owner walk: three role cards on the Admin hub |
| FX-14 | External hours: tracking only, never verified; separate log page; not in nav | Done·V | `LogExternalHours.jsx:285-295`; `LoggedHours.jsx:114,215-226`; `VolunteerDashboard.jsx:499-543` | Tracking-only + warning + back button done. See P2-21 for the button — **Final:** `8f656b2` (ruling 3) |
| FX-15 | RULE: no new menu-bar icons; entry points in existing surfaces | Done·V | — | Standing rule; checked across every item — **Final:** the only rail change in this engagement is Calendar for administrators (ruling 2); every new surface went into an existing page |
| FX-16 | Opportunities + Find merged cleanly | Done·V | `routes/index.jsx:273`; `BrowseEvents.jsx:104-109` | Visual check Phase 2 — **Final:** browser, Phase 5 walk: search, tabs, cards, apply from the modal |
| FX-17 | Avatar menu exactly Profile / Notifications / Settings / Sign Out; mobile Profile in overflow | Done·V | `ProfileMenu.jsx:146-185`; `accountMenu.js:70` | Extra "My hours" item. "Notifications" goes to *settings* on desktop, the *inbox* on mobile (A2). **Gate** for My hours — Ruling 3: exactly four items; A2 fixed as a defect — **Final:** `8f656b2` (ruling 3) |
| FX-18 | Dashboard zoom-out on mobile — investigate, fix only if real | Done·V | `index.html:38`; `e3c2190` | Zoom not blocked; sideways overflow fixed — **Final:** browser, Phase 2 |
| FX-19 | People/org search inside Opportunities; no Edit Profile item; edit button on profile; same layout | Done·V (owner-accepted) | `BrowseEvents.jsx:804`; `VolunteerProfile.jsx:135` | Edit opens a modal. **Gate** — Ruling 12: pop-up kept |
| FX-20 | One logo in both themes; favicon; emails | Done·V (owner-accepted) | `BrandMark.jsx`; `public/favicon.svg`; `server/email.js:675` | Email tile draws a plain "W", not the checkmark-W (clients strip SVG). **Gate** — Ruling 12: letter-W tile kept |
| FX-21 | Desktop: Profile not in nav, lives in avatar menu | Done·V | `App.jsx:480,2027` | P1: Profile is `secondary`, `accountOnly` |
| FX-22 | Owners/partners get custom profiles; @mahit shows student info for colleges | Done·V | `App.jsx:215-218`; `VolunteerProfile.jsx:112`; `Distinction.jsx` | — **Final:** browser, Phase 6 owner walk; founder page per rulings 19 and 21 (`6a4c6c2`) |
| FX-23 | `@` → only users; `#` → only tagged opportunities/orgs | Done·V | `BrowseEvents.jsx:249-300` | P1: sigil overrides type server-side |
| FX-24 | Applicants show events signed up and attended | Done·V | `ApplicantReview.jsx:208-225` | Counts, never % — **Final:** rehearsal (real routes), Phases 3 and 6; counts always shown (`c237410`) |
| FX-25 | Rename Opportunities tab, no longer than "Opportunities" | Done·V | `App.jsx:358` | "Discover". Organizers' page title says "Recruit" (FX-30) — **Final:** browser, Phase 5 walk: "Discover" in the rail and the title |
| FX-26 | About Us once, own non-heart icon | Done·V | `Settings.jsx:592-637` | `Info` icon — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| FX-27 | Org creation tags fail with "40 characters" | Done·V | `server/organizationTags.js:88-107`; `a9ded8d` | Root cause: `{tag,label}` objects — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) and rehearsal (real routes), Phases 3 and 6 (clubs created with tags) |
| FX-28 | Check-in and finalize hours — do they work, when? | Done·V | `attendance.js:29-34,477-553`; `attendanceRoutes.js:280-304` | Close-out only after every shift ends and everyone is accounted for — P1: lock re-read `FOR UPDATE`; refused before any other check |
| FX-29 | Friends can message; copy says organizers **and** friends | Done·V | `messageRoutes.js:60-95`; `recipientCopy.js:123-125` | — **Final:** browser, Phase 2 |
| FX-30 | `/events` → `/discover`; no naming discrepancies | Done·V | `VolunteerDashboard.jsx:274,435`; `OrganizerDashboard.jsx:344`; `CalendarView.jsx:371`; `ai/navigation.js:58` | No `/events` links remain; "Browse/Find opportunities" labels and "Recruit" do. **Gate** (N-13 declined these) — Ruling 5: "Discover" everywhere, incl. organizer title — **Final:** `e01e550`, `5dbd8c0` (rulings 5, 23) |
| FX-31 | Dashboard service record capped + "show more" → page | Done·V | `VolunteerDashboard.jsx:556-561` | Cap 3 → `/hours` — **Final:** browser, Phase 2 |
| FX-32 | Profile service record capped + "show more" | Done·V | `VolunteerProfile.jsx:261-267` | Cap 5, but on someone else's profile the link goes to **your** `/hours` (A3) — P1: A3 confirmed: `moreHref="/hours"` regardless of `isSelf` — **Final:** `290552e` |
| FX-33 | Reliable Volunteer as a badge beside applicants, hover text; fair model (history, recent, decay, recovery, volume); first-time and inactive badges; lost below 90%; not an achievement | Done·V | `server/reliability.js:61-96,222`; `ApplicantReview.jsx:142-205,238-262`; `c2f5fff` | Badge + decay + evidence floor + withdrawal done. No hover text; first-time is a tag; inactive badge declined; smoothing means exactly 90% never earns it. **Gate** — Ruling 4: hover text + first-timer badge — **Final:** `c237410` (ruling 4) |
| FX-34 | Hour ladder 5…250+, streak badges, descending, interleaved, "show more" to a page; Early Supporter; other good achievements | Done·V | `server/scripts/seed_badges.js:103-218`; `utils/badgeOrder.js`; `BadgesList.jsx:126` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`badgeOrder`), and the showcase interleaves the ladders in the browser (Phase 6) |
| FX-35 | Transcript and certificate print properly, light and dark | Done·V | `index.css:4397`; `printIsolation.test.js` | Tests parse CSS only — **print preview in Phase 2** — **Final:** browser, Phase 2; PDFs printed |
| FX-36 | Transcript lists events (total hours each), not shifts | Done·V | `VolunteerPortfolio.jsx:15-22,89,217` | Transcript done; a third document lists shifts (A7) — P1: A7 confirmed — **Final:** `c32be23` |
| FX-37 | Shift row cluttered | Done·V | `EventShiftsTab.jsx:239-314` | Icon buttons — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| FX-38 | Organizer map: normal theme, not high contrast | Done·V | `location/basemap.js`; `dba4001` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| FX-39 | Remove "Confirmed" pseudo-button from confirmed shifts | Done·V | `VolunteerDashboard.jsx:450-474` | — **Final:** browser, Phase 2 |
| FX-40 | Location banner: permission checked each load; dismissed per session | Done·V | `LocationContext.jsx:49-161` | Safari fallback noted — **Final:** browser, Phase 5 walk; dashboard scope narrowed by ruling 25 (`93d2967`) |
| FX-41 | Newest message at the bottom | Done·V | `ConversationPane.jsx:70,176-195`; `9a2465b` | Simulated conversation in Phase 3 — **Final:** browser, Phase 2 and rehearsal (real routes), Phases 3 and 6 |
| FX-42 | Organizers can kick before start only; never revoke hours | Done·V | `applicationRoutes.js:866-879,1024-1063` | Per shift, not per event (section C) — Ruling 12: per-shift kept — **Final:** rehearsal (real routes), Phases 3 and 6: 34 late removals refused |
| FX-43 | Org managers can remove members | Done·V | `OrganizationPage.jsx:200-239` | See FX-59/71/73 — **Final:** rehearsal (real routes), Phases 3 and 6 |
| FX-44 | Legal change → pop-up with changed lines + link; "your responsibility" clause; formatted email | Owner-action | `LegalUpdateNotice.jsx:157`; `LegalAcceptanceModal.jsx:136-237`; `notificationContent.js:62-69` | No responsibility clause — Terms §13 promises 30 days' notice instead. Wording is Owner-action (Posture B) — **Final:** drafted in `docs/legal/drafts/terms-section-13-changes.md` (`45ff705`); publishing is the owner's (Posture B) |
| FX-45 | Clarify certificate vs transcript | Done·V | `App.jsx:770,798`; `CertificatesPage.jsx:90-105` | Only implied; plus the third document (A7) — P1: A7 confirmed — a third document is the confusion — **Final:** `c32be23` |
| FX-46 | Certificate prints both names above the lines: Volunteer / Program Coordinator | Done·V | `CertificateDocument.jsx:115-124`; `certificatePdf.js:221-227` | — **Final:** browser, Phase 2 |
| FX-47 | Transcript prints without a white background | Done·V | `index.css:4397` | Print preview Phase 2 — **Final:** browser, Phase 2; plain white per ruling 15 (`c32be23`) |
| FX-48 | Transcript signature: Mahit Pulavarthi, Founder of WeVolunteer | Done·V | `src/config.js:72-74`; `VolunteerPortfolio.jsx:270-279` | — **Final:** browser, Phase 2 |
| FX-49 | Org pictures: upload, or emoji on a chosen colour (iMessage-style); same for users | Done·V | `OrgAvatar.jsx`; `EmojiAvatarPicker.jsx` | ~200 curated emoji, fixed palette — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) and browser, Phase 5 walk (avatar picker at signup) |
| FX-50 | Org announcements; replies; one org-level Allow Replies checkbox | Done·V | `OrganizationForm.jsx:209,460-463`; `OrganizationAnnouncements.jsx` | — **Final:** browser, Phase 2 and rehearsal (real routes), Phases 3 and 6 |
| FX-51 | Mobile regressions: dashboard scroll strips; "Message new people" size | Done·V | `Messages.jsx:170-181` | Runtime only (Phase 2) — **Final:** browser, Phase 2 |
| FX-52 | Welcome / login / signup load on mobile | Done·V | `a11y/workflows/mobile.spec.js` | Runtime only — **Final:** browser, Phase 2 |
| FX-53 | Printing prints only the document, not the page | Done·V | `index.css:4397`; `printIsolation.test.js:52-100` | Print preview Phase 2 — **Final:** browser, Phase 2; PDFs printed |
| FX-54 | Org picture in search results and Discover's org tab | Done·V | `BrowseEvents.jsx:893,923` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| FX-55 | @mahit looks like a student profile, keeps owner badge, holds every badge/achievement/hour/streak | Done·V | `bin/seed-qa-profile.mjs`; `ownerCompleteCollection.test.js` | Student look done. The "every badge" part exists only as a dev script writing unmarked real rows (A8). **Owner decision 1** — **Final:** `6a4c6c2` (ruling 19: drawn on the profile, nothing written) |
| FX-56 | Mobile login: Microsoft logo overflow; less scrolling | Done·V | `providerButtonContainment.test.js`; `cf2d81b`; `b9589b2` | Scroll length judged in Phase 2 — **Final:** browser, Phase 2 |
| FX-57 | Transcript signature (repeat) | Dup | — | → FX-48 |
| FX-58 | "Organizations" button → `/organizations` (list + create), same name everywhere | Done·V | `BrowseEvents.jsx:661-690`; `OrganizationsHome.jsx:63,83`; `0fe739d` | Named "Your organizations". **Gate** — Ruling 5: label becomes "Organizations" — **Final:** `e01e550` (ruling 5) |
| FX-59 | Kick dialog ("can join back", optional reason) + smaller red Ban (reason mandatory); notify; ban notice with appeal | Done·V | `RemoveMemberDialog.jsx:17-99`; `notificationContent.js:802-850` | — **Final:** rehearsal (real routes), Phases 3 and 6: ban without a reason refused |
| FX-60 | @mahit showcase (repeat) + account identity | Dup | — | → FX-55, FX-09 |
| FX-61 | Transcript name sits on the line; certificates unchanged | Done·V | `transcriptSignature.test.js:62-121` | — **Final:** browser, Phase 2 |
| FX-62 | Discover date box stretched for some events | Done·V | `dateChipGeometry.test.js` | Cause was height, not width — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`dateChipGeometry.test.js`) |
| FX-63 | Org-ban appeals seen by all org organizers, at the bottom | Done·V | `AppealInbox.jsx`; `OrganizationPage.jsx:776-777` | — **Final:** browser, Phase 2 and rehearsal (real routes), Phases 3 and 6 |
| FX-64 | Achievements "See all" → `/profile/badges` or `/users/@user/badges` | Done·V | `VolunteerProfile.jsx:194`; `PublicProfile.jsx:441` | `/users/@undefined/badges` when no username (A4) — P1: A4 confirmed — **Final:** `290552e` |
| FX-65 | Certificates capped + see all | Done·V | `VolunteerProfile.jsx:370-375` | — **Final:** browser, Phase 2 |
| FX-66 | Same cap for shifts and certificates | Done·V | `PreviewList.jsx:60` | — **Final:** browser, Phase 2 |
| FX-67 | Others' certificates visible, not downloadable; transcript hidden; privacy for hours and certificates; `/users/@user/hours` | Done·V | `PublicCertificates.jsx:118-135`; `certificateRoutes.js:115-117,181-183` | P1: view and PDF via `getCertificateForOwner`; `/portfolio` needs `portfolio.write` |
| FX-68 | Tag limits: 15 popular filter chips; 4 per event card | Done·V | `eventTags.js:261`; `EventCard.jsx:92` | Stale comment "three" (A14) — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`eventTags` tests) |
| FX-69 | Appeal button beside Join when banned | Done·V | `JoinAction.jsx:97-118` | — **Final:** rehearsal (real routes), Phases 3 and 6 |
| FX-70 | Join → Appeal when banned; disabled once sent; 5 per 30 days; organizers can report appeal spam | Done·V | `appealsRoutes.js:42-43,400` | No way to report appeal spam — P1: 5 per 30 days verified (`APPEAL_WINDOW_MAX`) — **Final:** `d41eecd`, `04b7c30` |
| FX-71 | One settings button per member → promote/demote (label by role), kick, ban | Done·V | `OrganizationPage.jsx:200-239,1000` | — **Final:** browser, Phase 2 |
| FX-72 | Do event tags exist? | Done·V | `server/eventTags.js` | 8 max, 30 chars — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| FX-73 | Member Manage button opened nothing | Done·V | `OrganizationPage.jsx:1000` | Click-through in Phase 2 — **Final:** browser, Phase 2 |
| FX-74 | `mailto:` links don't work | Done·V | `Settings.jsx:546-566` | Remain in `AboutUs.jsx:459`, `OrganizerProfile.jsx:120` (A9) — P1: A9 confirmed; the certificate share dialog's mailto is a deliberate share-by-email option and stays — **Final:** `381f374` |
| FX-75 | Report-a-problem page with category dropdown and screenshots | Done·V | `ReportIssue.jsx:194-206`; `issueRoutes.js:97` | No screenshot upload — **Final:** `11cd2c5` |

### CK — "Issues to check" (14)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| CK-01 | 2FA "Internal Server Error"; email always offered; recovery codes always a fallback; save codes as .txt or .png | Done·V (owner-accepted) | `fb934d0`; migration 055 (`f26f827`); `twoFactor.noFiveHundred.test.js`; `recoveryCodeExport.js:126,146` | Two root causes fixed. Email offered only for a *confirmed* address (section C). .txt and .png both exist — Ruling 12: email 2FA for confirmed addresses kept — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`twoFactor.noFiveHundred.test.js`) |
| CK-02 | No 500 for email, authenticator or recovery codes | Done·V | `twoFactor.noFiveHundred.test.js:112-300`; `routes.2faEmail.test.js:332` | Browser end-to-end in Phase 2 — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`twoFactor.noFiveHundred.test.js`, `routes.2faEmail.test.js`); and browser, Phase 6 owner walk (email code sign-in) |
| CK-03 | "9 codes remaining" after an authenticator sign-in | Done·V | `authRoutes.js:1400-1430`; `ae4fe03` | Count was right; copy now explains it — P1: count computed only when a recovery code is spent |
| CK-04 | Removing the authenticator still showed it | Done·V | `fd47c47`; `0d18cd4`; `TwoFactorSetup.jsx:342` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| CK-05 | Change-email dialog can't be closed; check every dialog | Done·V | `VerifyIdentityModal.jsx:385`; `ae4fe03` | 7 overlays use `useModal` without `Modal` — each tested in Phase 2 — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`dialogSemantics.test.jsx`) |
| CK-06 | Adding a second factor doesn't reset recovery codes | Done·V | `twoFactorRoutes.js:244-275` | P1: codes issued only when none exist |
| CK-07 | AI mode available to everyone under `npm run dev` | Done·V | `vite.config.js:69`; `server/authz.js:131,217,346` | Works on desktop; **iPhone/iPad get none** (A13) — Ruling 7: iPhone opt-in to Balanced — **Final:** `0c35281` (ruling 7); on-device trial on an iPhone is the owner's |
| CK-08 | 2FA still 500s (repeat, "serious") | Dup | — | → CK-01/02 |
| CK-09 | Banned: red "Appeal" with ban text; sent → grey with clock; icons on buttons | Done·V | `JoinAction.jsx:97-118` | — **Final:** rehearsal (real routes), Phases 3 and 6 |
| CK-10 | Banned-member list with unban (Discord-style) | Done·V | `BannedMembers.jsx:18-148` | — **Final:** browser, Phase 2 |
| CK-11 | Student dashboard: hours box above the stat strip | Done·V | `VolunteerDashboard.jsx:322,363,373-395`; `a5bbf6c` | — **Final:** `7c9cad1` |
| CK-12 | Organizer dashboard: stat strip above "Ready when you are" | Done·V | `OrganizerDashboard.jsx:469-545` | Card renders above; the test asserts nothing about order (A1) — P1: Misread in `a5bbf6c`: "review hours box" taken as the Awaiting-review tile; the owner pasted the close-out card as that box. Card must go below the strip, and the tile swap (not asked for — "keep everything as is") reverted — **Final:** `7c9cad1` |
| CK-13 | Welly's advanced model won't start | Done·V | `ai/runtime/modelCache.js`; `083b7d1`; `1295a1e` | Truncated 986 MB download reused forever — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| CK-14 | Welly creates real events by conversation, explains refusals in plain English | Done·V | `ai/eventDraft.js:358,600-650`; `ai/eventCreation.test.js` | Conversation quality needs a live run — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`ai/eventCreation.test.js`) |

### EM — Email

| ID | Request | Status | Evidence | Notes |
|---|---|---|---|---|
| EM-01 | Sender profile picture on emails (also "Email stuff I have to worry about") | Owner-action | `docs/EMAIL_BRANDING.md:20-111` | Needs BIMI + enforcing DMARC + a paid VMC for Gmail; Gravatar on the sending address is the free route. None is code — **Final:** unchanged: BIMI or Gravatar on the sending address; not code |

### P2 — The Phase 2 feature list (51)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| P2-01 | Download data and delete account | Done·V | `privacyRoutes.js:51,103,146`; `accountRoutes.js:57` | Both re-verify identity — **Final:** browser, Phase 6 owner walk: Settings → Privacy "Your Data" export; Settings → Security "Danger Zone" deletion |
| P2-02 | Improved notifications | Done·V | `NOTIFICATION_KINDS`; 09-21 Pass 5 | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) and rehearsal (real routes), Phases 3 and 6 (2,718 notifications) |
| P2-03 | DMs | Done·V | `messageRoutes.js` | — **Final:** rehearsal (real routes), Phases 3 and 6: 80 messages in 40 conversations |
| P2-04 | Calendar integration | Done·V | `server/ics.js:112-154` | .ics with location + alarm; no Google Calendar link; dead `downloadIcs` (A14) — **Final:** `08b5a8a` |
| P2-05 | "Add to Home Screen" | Done·V | `public/site.webmanifest` | No service worker or install prompt — deliberately deferred. **Gate** — Ruling 9: install prompt, no service worker — **Final:** `4c4bb09` (ruling 9) |
| P2-06 | Better mobile experience and OAuth | Done·V | `server/config.js:515-517,666-669` | Google + Microsoft done; Apple needs a paid developer account (Owner-action) — **Final:** Google and Microsoft; Apple needs a paid developer account (Owner-action) |
| P2-07 | Better 400/500 handling | Done·V | `ErrorExperience/*`; `app.errorMapping.test.js` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`app.errorMapping.test.js`) |
| P2-08 | Privacy Policy and ToS | Done·V | `docs/legal/policies/` (13 documents) | — **Final:** browser, Phase 5 walk: 13 documents render; italics fixed `6fefbe2` |
| P2-09 | Master dashboard: active users, events, hours, top tags, "we helped N people" | Done·V | `AdminImpact.jsx:285,459-586`; `OwnerCenter.jsx:1044-1054` | No headline "we helped" figure — **Final:** `cd8638b`; browser, Phase 6 owner walk |
| P2-10 | Personal account switches between all roles; can create and apply | Done·V | → FX-08 | — **Final:** as FX-08 |
| P2-11 | Email box: promote existing account or store for later; admin log; revoke; no new super admins | Done·V | `invitationRoutes.js:35,116`; `adminInvitations.js`; `bin/grant-ownership.mjs` | Invitee must accept (consent + Policy 10). **No allowlist**: the CLI can make any email super_admin (A11). **Gate** — Ruling 6: keep accept-to-join; lock ownership to two addresses — **Final:** `5e231cd` (ruling 6) |
| P2-12 | Revoke: unapprove organizer, ban student, demote admin; records kept | Done·V | `adminRoutes.js:109,1518,1609,2359` | An approved organizer cannot be unapproved — **Final:** `125d645`, `d8baa65` |
| P2-13 | Profile pictures | Done·V | → FX-49 | — **Final:** as FX-49 |
| P2-14 | Real badges | Done·V | → FX-33/34 | — **Final:** as FX-33, FX-34 |
| P2-15 | 2FA | Done·V | → CK-01…06 | — **Final:** as CK-01 to CK-05 |
| P2-16 | One date picker everywhere, themed | Done·V | `DatePicker.adoption.test.jsx`; `EventEditForm.jsx:157,252,256`; `OrganizerDashboard.jsx:752`; `ShareOrganizationDialog.jsx:712,777` | Native inputs remain; calendar has no jump-to-date; N-16 declined these. **Gate** — Ruling 8: picker everywhere, typing kept — **Final:** `ac5ee35`, `7c6face` (ruling 8) |
| P2-17 | Signed-up vs attended counts, not %; on profile too | Done·V | → FX-24; `PublicProfile.jsx:379-381` | — **Final:** rehearsal (real routes), Phases 3 and 6; counts always shown (`c237410`) |
| P2-18 | Public `/users/:handle`; private mode hides grade/school/PII; placeholder text; public stats; show-up rate in Auto Select below hours | Done·V | `profileSerializer.js:178,192,345-364`; `ProfileEditModal.jsx:309`; `server/weighting.js` | — **Final:** browser, Phase 5 walk and browser, Phase 6 owner walk; private by default since `aed176c` (owner, 2026-10-04) |
| P2-19 | Organizers adjust time stayed; "left early" subtract checkbox | Done·V | `EventAttendance.jsx:356-378` | Editable actual hours instead of a checkbox. **Gate** (section C) — Ruling 12: actual-hours box kept — **Final:** rehearsal (real routes), Phases 3 and 6: left-early adjustments credited |
| P2-20 | Events without hours | Done·V | `CreateEvent.jsx:101,309,573-575` | — **Final:** rehearsal (real routes), Phases 3 and 6; participation certificates (`3373f79`) |
| P2-21 | "Log external hours" button like "Create event"; warning it won't reach the transcript | Done·V | `LoggedHours.jsx`; `VolunteerDashboard.jsx:499-543` | Button only on `/hours`; the dashboard has "My logged hours". **Gate** — Ruling 3: dashboard "Log external hours" button — **Final:** `8f656b2` (ruling 3) |
| P2-22 | `/users/@username`; ⋯ menu Mute / Restrict / Report / Block; Friend + notification when a friend applies | Done·V | `PublicProfile.jsx:171-219,262`; `relationships.js:373-384`; `applicationRoutes.js:679` | — **Final:** rehearsal (real routes), Phases 3 and 6: 200 friend requests, reports, blocks |
| P2-23 | Organizations: organizers create, anyone joins, org link on events notifies members | Done·V | `server/authz.js:177,239,250`; `eventRoutes.js:1153` | — **Final:** rehearsal (real routes), Phases 3 and 6: three clubs, events linked |
| P2-24 | "Legal Center"; About Us with mission and motto | Done·V | `AboutUs.jsx:199,448` | — **Final:** browser, Phase 6 owner walk: About (mission, vision, motto, who runs it) and the Legal Center's five groups |
| P2-25 | Owner legal editor: versions only go up, green Save / red Discard, from Settings | Done·V | `legal/LegalEditor.jsx:42,785,794`; `legalAdminRoutes.js:210` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`LegalEditor.test.jsx`, `legalStore.test.js`) |
| P2-26 | Better dashboard graphs | Done·V | `ServiceInsights.jsx`; `BarChart.jsx` | Judged in Phase 2/5 — **Final:** browser, Phase 6 owner walk: Platform Impact month chart and its table view |
| P2-27 | Near-me filter; location as a maps link; calendar location; weather | Done·V | `BrowseEvents.jsx:33-91`; `LocationLink.jsx:27-60`; `ics.js:17-21`; `WeatherSummary.jsx` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (location, maps link, .ics, weather tests) |
| P2-28 | QR: @username + time, 5-min expiry, only after start; organizer scan only after start; manual kept | Done·V | `checkinTokens.js:32-38`; `CheckInCodeModal.jsx:125-160`; `attendanceRoutes.js:56,869` | Organizer check-in opens 2 h before the first shift. **Gate** (A6) — A6 withdrawn: QR code exists only after the volunteer's shift starts — **P3: reopened by R1 — every code shows the name, not @username** — **Final:** `0e74e2a`; rehearsal (real routes), Phases 3 and 6 (86 codes show @username) |
| P2-29 | Hours per organization; org tags vs regular tags; an org prefix? | Done·V | `organizationHours.js`; `directoryRoutes.js:278-320` | Per-org hours done; `#` shares one namespace. **Gate** — Org hours use organization_id, never tags |
| P2-30 | On-device LLM; recommendations ("Suggested for you", keep icon); distance; near-me sort; AI tag suggestions | Done·V | `ai/models.js:98-190`; `BrowseEvents.jsx:704,982`; `TagSuggestions.jsx:62` | Qwen2.5 0.5B / 1.5B; SmolLM2-135M not used for chat — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| P2-31 | Scan a paper certificate → prefill external hours | Done·V | `ai/certificate/extract.js:124-137` | PDF text layer only; no OCR for photos — **Final:** `d989b2b`, `77223f2` (ruling 20: never the hours) |
| P2-32 | "Enable AI mode" offer on "Suggested for you"; blurred explainer; AI policy link; 3 tiers, Recommended + green ring | Done·V | `AIEnableModal.jsx:34-142`; policy 12 | Modal only from Settings; 2 tiers. **Gate** — Ruling 7: offer banner; 2 sizes kept — **Final:** `0c35281` (ruling 7) |
| P2-33 | A small chatbot with user and event context; verifies certificates | Done·V | `src/ai/`; `WellyView.jsx` | Verify moved to a dashboard button — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) and browser, Phase 2 (Welly Chat answered hours) |
| P2-34 | Name, logo, personality, system prompt; not a generic corner bubble; visible under `npm run dev` | Done·V | `ai/prompts/welly.js:39-141`; `App.jsx:394` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| P2-35 | Talks freely, proper punctuation, excellent answers | Done·R (owner to judge) | `WllamaRuntime.js:333` (`8c1342b`) | Quality is a runtime judgement (Phase 2) — **Final:** answer quality is a judgement on the running model, which this audit could not run in Node; the split-word defect behind it is fixed (P2-40) |
| P2-36 | Own nav entry with the Spark icon; history; responsive | Done·V | `App.jsx:394`; `68352dd` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| P2-37 | Mobile bar not cramped | Done·V | `mobileNavFit.test.js:135-207` | Phase 2 — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`mobileNavFit.test.js`) and browser, Phase 2 at 375 |
| P2-38 | Clearer mode names | Done·V | `WellyModeControl.jsx` | "Welly Chat" / "Welly AI" — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| P2-39 | Button beside "Welly" → model setup | Done·V | `WellyView.jsx` | First choice of Welly AI goes to Settings. **Gate** — Mode control beside the name opens setup |
| P2-40 | On-device replies no longer split words/punctuation | Done·V | `8c1342b` | wllama final-chunk defect; non-streaming call — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (the non-streaming call; see memory "wllama final-chunk") |
| P2-41 | Same quality in chat mode | Done·V | — | Phase 2 — **Final:** browser, Phase 2 |
| P2-42 | Near-me no longer defaults to chat mode; verify as a real button; disclaimer instead of a verify link | Done·V | `WellyView.jsx:661-711,1423,1445-1457` | Disclaimer omits "nothing leaves your device" because it would be false (search reaches the server/Pinecone). **Gate** (section C) — Ruling 14: add the precise on-device sentence — **Final:** `3c9de47` (ruling 14, amended by the owner 2026-10-04) |
| P2-43 | Seamless dropdown switching; first time → download screen | Done·V | `WellyModeControl.jsx:1-56` | Button panel, not a dropdown. **Gate** — Dropdown switches immediately; first pick → download |
| P2-44 | Commits not linked to the GitHub profile | Done·V | `git log` (Phase 0) | Resolved |
| P2-45 | Never ask the user to type location or personal info | Done·V | `WellyView.location.test.jsx`; `ai/personalInfo.test.js` | — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`WellyView.location.test.jsx`, `ai/personalInfo.test.js`) |
| P2-46 | `/verify` reachable, small, not in the nav | Done·V | `VerifyCertificateAction.jsx:51` | Dashboards only; not from signed-out pages — **Final:** browser, Phase 5 walk: a small button on every dashboard, not in the rail |
| P2-47 | Logo: green tile, white checkmark-W, name beside it; in emails | Done·V (owner-accepted) | `BrandMark.jsx`; `server/email.js:675` | → FX-20 — Ruling 12, via FX-20 |
| P2-48 | Starting a preview lands on the dashboard | Done·V | `ModerationCenter.jsx:316`; `b166dad` | — **Final:** browser, Phase 2 and browser, Phase 6 owner walk |
| P2-49 | Admin text all underlined | Done·V | `3380996` | Other admin pages checked Phase 2 — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) |
| P2-50 | Attachments (images, PDFs, audio) in DMs and announcements | Deferred | — | Owner decision 3 (2026-09-30) |
| P2-51 | More Welly work | Dup | — | Folded into Phase 2/5 findings — **Final:** folded into P2-32 to P2-45 |

### LG — Legal and event-form items (13)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| LG-01 | ADA compliance: plan + implementation | Partial·V | `a11y/` suites; `docs/audits/2026-08-22-accessibility-audit.md` | Manual screen-reader pass open; certificate PDFs untagged — **Final:** automated sweeps pass; a manual VoiceOver/NVDA pass and tagged certificate PDFs remain (Owner-action: needs a person with a screen reader) |
| LG-02 | DMCA policy? EULA? | Done·V | `docs/legal/13-ACCEPTABLE-USE-AND-ABUSE-REVIEW.md:25-135`; Terms :383 | DMCA procedure in Terms; agent registration is Owner-action; EULA rejected as the wrong instrument — Ruling 13: separate AUP to draft; EULA asked separately — **Final:** drafts `45ff705`, `dfeb4d2` (AUP, EULA); DMCA agent registration and publishing are Owner-actions |
| LG-03 | Factor pending applications into Auto Select; cap at 10 events | Declined-by-owner | `server/config.js:435-455`; `applicationRoutes.js:623-635`; `services/autoSelect.js:160-231` | Cap done; pending not weighed. **Gate** — Ruling 10: cap kept, no Auto Select penalty |
| LG-04 | Does the legal text cover DDoS, automation, disruption? Is automation fair? AUP needed? | Done·V | Terms §4 (`02-terms-of-service.md:159-224`) | AUP folded into Terms (section C) — Ruling 13: separate AUP — **Final:** draft `45ff705` (ruling 13); publishing is the owner's |
| LG-05 | No XSS from user content; Welly prompt injection | Done·V | no `dangerouslySetInnerHTML`; `policyMarkdown.js`; `WellyMessage.jsx:90-127`; `ai/indirectInjection.test.js` | P1: zero `dangerouslySetInnerHTML`, zero `innerHTML =` in `src/` |
| LG-06 | Profile picture "under 5kb" and safe | Done·V (owner-accepted) | `profilePictureRoutes.js:118-222` | 5 MB upload; stored as ≤5 KB 192 px WebP — quality check Phase 2 — Ruling 12: 5 KB stored kept — **Final:** behavioural tests in the final suite (`d8baa65`, 11,530 passed) (`profilePicture.storedSize.test.js`) |
| LG-07 | Regroup the Legal Center | Done·V | `legal/LegalCenter.jsx:63-108` | 13 documents in 4 groups — **Final:** browser, Phase 5 walk |
| LG-08 | Hours final after close-out; correctable before | Done·V | `attendance.js:477-553` | Matches 09-21 1A — P1: `finalizeAttendance` is the only writer; lock is its floor |
| LG-09 | Applications closing after the event (Sep 5 vs Aug 18) | Done·V | `server/validation.js:33-39`; `CreateEvent.jsx:269-272` | Refused both sides, but client `>=` vs server `>` (A5) — P1: A5 confirmed — **Final:** `f20f4ab` |
| LG-10 | Category list too narrow, badly grouped | Done·V | `server/eventCategories.js:68-126` | 16 in 6 groups — **Final:** browser, Phase 5 walk: 16 categories in groups on the event form |
| LG-11 | Application-close field uses the custom picker; click opens it | Done·V | `CreateEvent.jsx:444-462`; `DatePicker.jsx:82-90` | Still accepts typing; time is native. **Gate** — Ruling 8 — **Final:** `ac5ee35`, `7c6face` (ruling 8) |
| LG-12 | "Select / Selected" until Apply; Apply easy to find | Done·V | `EventShiftsTab.jsx:319-365` | Placement judged Phase 2 — **Final:** browser, Phase 5 walk: Select → Selected → "Send application for 1 shift · 2 hrs total" |
| LG-13 | Gap between tags and the green box | Done·V | `EventHero.css:7-12` | Visual — **Final:** browser, Phase 6 owner walk: 12 px between the tags and the details box, the modal's own spacing |

### SC — Scaling, Owner Center, final passes (12)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| SC-01 | Upstash for caching, sessions, rate limiting, leaderboard, chat | Done·V (owner-accepted) | `server/redis/*`; `docs/operations/upstash.md:23-60,230-245` | Rate limits + caches only; the rest measured and kept in SQL on free-tier grounds. **Gate** (section C) — Ruling 11: narrow by measurement |
| SC-02 | Caching, async jobs, fast queries, load tests, horizontal scaling | Done·V | `load-testing.md`; `horizontal-scaling.md`; `bin/multi-instance-check.mjs` | — **Final:** documents and `bin/multi-instance-check.mjs` present; no new scaling work requested |
| SC-03 | Owner Center: Better Stack + Amplitude (controls over links), free only | Done·V | `ownerRoutes.js:96-191`; `OwnerCenter.jsx:881-1200` | — **Final:** browser, Phase 6 owner walk: Owner Center systems, errors, uptime, usage, infrastructure |
| SC-04 | Custom certificate viewer; distinct Download and Share; share to socials and by DM | Done·V | `CertificateView.jsx`; `CertificateShareDialog.jsx:26-147` | No "send by direct message" — **Final:** `b75a16b` |
| SC-05 | Stripe donations | Deferred | — | Owner: "after launch" |
| SC-06 | Org share links like certificate share; signed-out Join prompts sign-in | Done·V | `ShareOrganizationDialog.jsx`; `SignInToJoinDialog.jsx` | — **Final:** rehearsal (real routes), Phases 3 and 6: invite-only club by share link |
| SC-07 | Org security: link-only join, who may invite, request-to-join; org page redesign | Done·V | `organizationPolicy.js:28-81`; `MembershipPolicyFields.jsx`; `JoinRequestInbox.jsx` | Visual redesign → revamp hand-over — Ruling 12: request-to-join mode kept — **Final:** rehearsal (real routes), Phases 3 and 6: open, request-to-join and invite-only |
| SC-08 | Notice system: minor legal change = banner like location's; major = blocking modal; never both; no gap | Done·V | `LegalUpdateNotice.jsx`; `AppNotices.test.jsx:88-110`; `noticeSlot.test.js:42` | Modal copy differs from the owner's wording — **Final:** browser, Phase 5 walk: one notice at a time (the consent card held the slot over the location offer) |
| SC-09 | Upstash + Pinecone in Owner Center; re-verify every external API | Done·V | `ownerRoutes.js:96-260` | No Google/Microsoft sign-in or Cloudflare checks — **Final:** `4684d90`; browser, Phase 6 owner walk |
| SC-10 | Coherence review against professional apps | Done·V | — | Phase 5 — **Final:** Phase 5, below: seven fixes and rulings 23 to 25 |
| SC-11 | Unfinished work, TODOs | Done·V | one "coming soon" (Apple) | Tech-debt register rechecked in Phase 6 — **Final:** Phase 6 sweep: no TODO/FIXME; the one "coming soon" is the filtered Apple state |
| SC-12 | Final audit of everything; 100-user week rehearsal | Done·V | — | Phases 3 and 6 — **Final:** this document: Phases 0 to 6, the week rehearsed twice on SQLite and PostgreSQL with zero anomalies |

### FE — Frontend, SEO, domains (5)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| FE-01 | Massive frontend revamp | Deferred | tokens; `docs/features/interface-motion.md`; `98b3f63` | Owner decision 4 — separate engagement |
| FE-02 | Meta description per public page; sitemap; Search Console | Done·V | `index.html:29` | One generic description; no `robots.txt` / `sitemap.xml` — **Final:** `48cc211`; Search Console verification is an Owner-action |
| FE-03 | Marketing site at `wevolunteers.org`, app at `app.wevolunteers.org` | Done·V | `deploy/nginx/wevolunteers.conf:72,82` | App subdomain live; no marketing site — revamp hand-over — **Final:** www.wevolunteers.org is live as the info site (`site/`, Cloudflare Workers, 2026-10-04; `docs/operations/info-site.md`), with the app at app.wevolunteers.org. Restyling either is the revamp's |
| FE-04 | Cloudflare DNS, secure | Done·V | `docs/operations/oracle-zero-cost-deployment.md` | Proxied, Full (strict), DNSSEC, origin locked to Cloudflare — **Final:** live: Cloudflare proxy and origin lock recorded in the deployment runbook and the 2026-09-29 rollout |
| FE-05 | The service list | Superseded | — | See "the roadmap is not the blueprint" |

---

## Findings not on the owner's list

Surfaced by triage; each is wrong regardless of anyone's preference. **Reported.**

| # | Finding | Evidence |
|---|---|---|
| A1 | Organizer close-out card above the stat strip; order unasserted | `OrganizerDashboard.jsx:469-545` |
| A2 | Avatar-menu "Notifications": settings on desktop, inbox on mobile | `ProfileMenu.jsx:150` |
| A3 | "Show all N shifts" on another person's profile links to your own `/hours` | `VolunteerProfile.jsx:266` |
| A4 | `/users/@undefined/badges` for accounts with no username | `VolunteerProfile.jsx:194` |
| A5 | Deadline rule: client `>=`, server `>` | `CreateEvent.jsx:269`; `validation.js:33-39` |
| A6 | Organizer QR scanning opens 2 h early (**gate**: may be deliberate) | `attendanceRoutes.js:56,869` |
| A7 | Dashboard "Hours certificate" modal: a third document, lists shifts, no verification code | `VolunteerDashboard.jsx:334,645-690` |
| A8 | `seed-qa-profile.mjs` bypasses the hours ledger; guard is filename-only | `bin/seed-qa-profile.mjs` |
| A9 | Remaining `mailto:` links | `AboutUs.jsx:459`; `OrganizerProfile.jsx:120` |
| A10 | Hub named three ways; tiles ≠ page titles | `ai/navigation.js:154`; `ModerationCenter.jsx` |
| A11 | No owner allowlist on `grant-ownership` / `bootstrap-owners` | `bin/grant-ownership.mjs` |
| A12 | Schema drift undetectable; migration 055 undocumented | `server/migrations/055_*`; `f26f827` |
| A13 | No Welly AI on iPhone/iPad; iOS message unreachable | `ai/capability.js:124-137`; `ai/models.js:137-146` |
| A14 | Stale comments/docs and dead code | `email.js:457-480`; `EventCard.jsx:87`; CHANGELOG; ENGINEERING_GUIDE §10.5; `helpers.js:198`; `src/config.js:52` |

---

## The decision gate — **CLOSED 2026-09-30**

Every Done-Differently item, and every Partial item whose gap was a deliberate
choice, was verified in code first and then put to the owner. Verification
removed five items from the list before any question was asked:

| Item | Why it left the gate | Evidence |
|---|---|---|
| **A6 / P2-28** QR check-in opening 2 h early | A volunteer's code is issued only once **their own** shift has started, so no QR check-in can happen before start. The 2-hour window governs manual check-in, which the owner asked to keep | `attendanceRoutes.js:765-771` (`checkin_not_started`) |
| **P2-29** `#tag` collisions with organizations | Per-organization hours are summed through `events.organization_id`, written behind a management check — never through tags, for exactly the `#Fun` reason the owner gave. `#` returning tagged events *and* organizations is what FX-23 asked for | `server/organizationHours.js:1-31`; `directoryRoutes.js:278-300` |
| **P2-43** mode switching | The control beside Welly's name is a dropdown whose two options switch immediately; the first choice of Welly AI goes to the download screen — the owner's description | `WellyModeControl.jsx:1-56` |
| **P2-39** button beside the name | Same control; it opens the model setup | as above |
| **P2-19** partially — see ruling 12 | — | — |

### Rulings

| # | Item | Ruling | Consequence for Phase 4 |
|---|---|---|---|
| 1 | FX-03 suspension | **Red border over a static blurred backdrop** | A red-bordered card over a decorative blurred backdrop that looks like the app but loads none of it. Keeps all three reasons the live blur was reverted |
| 2 | FX-12 admin Calendar | **Add it** — overturns the predecessor's 6A | Admin bar: Dashboard · Discover · Calendar · Messages · Admin. An admin's calendar shows all platform events |
| 3 | FX-17 / P2-21 | **Exactly four menu items + a dashboard button** | Remove "My hours" from the account menu (desktop and phone sheet); add "Log external hours" beside "My logged hours" on the dashboard. Fixes the dashboard comment that claimed to be the only entry |
| 4 | FX-33 | **Hover text + first-timer badge** | Honest hover text ("Consistently shows up for the shifts they take" — never "90%", which the smoothing makes false); first-time volunteer becomes a real badge; the neutral "last volunteered" line stays in place of an "inactive" badge |
| 5 | FX-30 / FX-58 | **The owner's words everywhere** | "Organizations" for the button; "Discover" for every "Browse/Find opportunities" label and for the organizer's page title (replacing "Recruit"). `labelDestinations.test.jsx` keeps one label → one route |
| 6 | P2-11 / A11 | **Keep accept-to-join; lock ownership to the two addresses** | An allowlist of the two owner addresses enforced wherever `super_admin` is granted (both CLIs and any server path). *security-review* |
| 7 | P2-32 / A13 | **Offer banner + iPhone opt-in** | "Enable AI mode?" offer on *Suggested for you* in the same notice style as the location banner; two model sizes stay; on iPhone/iPad the Balanced model is offered behind a clear "experimental on this device" warning, since the 200 MB ceiling was never measured |
| 8 | P2-16 / LG-11 | **Custom picker everywhere; opens on click; typing kept** | Replace the remaining native inputs (event edit form, quick edit, organization share dialog); add jump-to-date to the calendar; typing stays as the keyboard/screen-reader fallback |
| 9 | P2-05 | **Install button, no offline** | An install prompt where the browser supports one and short iPhone instructions. No service worker |
| 10 | LG-03 | **Don't add** | The 10-event cap and Terms §4 already cover the automation concern. Recorded as Declined-by-owner |
| 11 | SC-01 | **Keep Redis narrow** | No change |
| 12 | Kept as built | FX-19 profile edit in a pop-up · P2-19 actual-hours box · FX-20/P2-47 email tile with a letter W · CK-01 email 2FA only for a confirmed address · FX-42 kick blocked per shift · SC-07 request-to-join as its own mode · LG-06 avatars stored at ≤ 5 KB | Status becomes **Done** (owner-accepted) |
| 13 | LG-02 / LG-04 | **Not kept** — the owner wants a separate Acceptable Use Policy | Draft an AUP as a Legal Center reference document (no acceptance of its own), for the owner to publish. Whether he also wants an **EULA** was bundled in the same option and is asked separately rather than assumed |
| 14 | P2-42 | **Add the precise version** — **amended by the owner 2026-10-04** | Disclaimer gained: "With Welly AI on, what you type stays on your device; lookups use WeVolunteer like the rest of the app." That was false: a search sends the words searched for to `GET /api/events`, which may pass them to Pinecone, and `WellyView.disclaimer.test.jsx` failed on it once run with Welly AI on. Replaced, with the owner's approval, by the info site's sentence: "With Welly AI on, the model that writes Welly's replies runs on your device. Looking something up, like your hours or events to join, is a request to WeVolunteer like the rest of the app, and a search sends the words you searched for." See `docs/legal/drafts/welly-privacy-wording.md` |

Plain defects found while verifying, fixed without a ruling: **A2** (the
avatar menu's "Notifications" opens settings on desktop and the inbox on a
phone — it will open the inbox on both, the page the owner's mobile layout
names).

## Owner actions

Listed, not performed.

- Verify the production `@mahit` handle; decide about any conflicting account (FX-09).
- Claim or register the never-used `owner_wevolunteerplatfor` account and accept Policy 10 on it.
- Publish legal wording this audit drafts (FX-44 clause, modal copy) and the pending Privacy Policy corrections.
- DMCA agent registration (LG-02). Apple Sign-In needs a paid developer account (P2-06).
- Sender avatar: BIMI/VMC or Gravatar (EM-01).
- ~~Search Console property and sitemap submission (FE-02)~~ — done (Phase 8): the Domain property `sc-domain:wevolunteers.org` already existed and was verified; the info site's sitemap was submitted on 2026-10-04 and the app's on 2026-10-07, after `283b9d7` stopped robots.txt disallowing it.
- ~~Run the demonstration-record seed against production~~ — superseded by
  ruling 19: the showcase is drawn on the profile and needs no seed (FX-55).
- ~~Pushing~~ — the owner asked for `main` to be pushed at the end of Phase 8
  (2026-10-08), after the last deploy.

Added by Phases 4 to 6:

- ~~Publish the drafts in `docs/legal/drafts/`~~ — all four are live (Phase 8):
  the Acceptable Use Policy and End-User License by deploy; Terms 2.0.0
  (effective 2026-11-06) and AI and On-Device Processing 2.0.0 (effective
  2026-10-07) through the Legal Center editor, the owner signing in and
  passing the identity check, each verified byte-identical to its committed
  draft from the public API (`a8595349…`, `9c664582…`).
- Set `PLATFORM_OWNER_USERNAME=mahit` on the host if the founder, not the
  platform account, should answer `/api/platform/owner`.
- Check that the production build's `VITE_SCHOOL_NAME` does not read as a
  district operating the platform (W3, Posture B).
- A manual screen-reader pass (VoiceOver, NVDA) and tagged certificate PDFs
  (LG-01): the automated sweeps pass, but they are not a person with a screen
  reader.
- ~~Try Welly AI on a real iPhone~~ — the owner tried it on his own iPhone on 2026-10-08 and it worked, on the compatibility engine (ruling 7's experiment, now confirmed on a device).
- Do not delete the legacy B2 backup key before 2026-10-22 (memory "Backup key
  rotations").
- ~~Dependency advisories that predate this engagement~~ — taken in `4573788`
  and `9ade72f`, and live since Phase 8.


---

## Phase 1 — Static verification

**Method, and one deliberate change of order.** The decision-gate items were
verified first, so the owner could rule while the rest was checked; the gate
closed the same day. Then the fourteen defects (A1–A14), then the logic that
the rest of the product leans on — the close-out lock, removal before a shift,
certificate and transcript privacy, the appeal window, recovery-code
accounting, raw-HTML sinks. Those are graded **V** in the ledger with the line
that makes each true.

What remains at **R** after this pass is, almost entirely, *presence*: a button
exists, a page renders, a label reads a certain way. Reading source is weak
evidence for presence and strong evidence is a screenshot, so those items are
confirmed in Phase 2 in the browser rather than twice.

### Defects — verification record

| # | Result | What was read |
|---|---|---|
| A1 | **Confirmed, and wider than reported** | `OrganizerDashboard.jsx:469-545`: the close-out card renders before `<section className="stats">`. The commit that "fixed" CK-12 (`a5bbf6c`) read "the review hours box" as the *Awaiting review* tile and swapped two tiles — while its own message describes "the close-out card below", which it never was. The owner's message names the box by pasting it: it is the close-out card. |
| A2 | Confirmed | `ProfileMenu.jsx:150` → `/settings?section=notifications`; `App.jsx:457` (phone sheet) → `/notifications` |
| A3 | Confirmed | `VolunteerProfile.jsx:266` `moreHref="/hours"` unconditionally |
| A4 | Confirmed | `VolunteerProfile.jsx:194` interpolates `volunteer?.username` with no fallback |
| A5 | Confirmed | client `>=` refuses equality (`CreateEvent.jsx:269`); server refuses only `>` and its message says "on or before" (`validation.js:115`) |
| A6 | **Withdrawn** | see the gate |
| A7 | Confirmed | `VolunteerDashboard.jsx:645-700`: "Certificate of Community Service", one table row per shift, no verification code |
| A8 | Confirmed | `seed-qa-profile.mjs:57-61` refuses three basenames; `bin/lib/db-safety.mjs` already has the content-based `refuseNonDisposableDatabase`. Ruling 1 needs a *second*, deliberately production-capable tool for the owner's demonstration record, so the fix is a split, not a swap |
| A9 | Confirmed | `AboutUs.jsx:459`, `OrganizerProfile.jsx:120` (which also exposes the organizer's address) |
| A10 | Confirmed | Welly calls the hub "Moderation Center" (`ai/navigation.js:154`); tiles read "Administrators" and "Audit trail" against the owner's "Admin Roster" and "Audit Explorer" |
| A11 | Confirmed by triage; fix is ruling 6 | — |
| A12 | Confirmed | CHANGELOG never names migration 055 or the table it repaired |
| A13 | Resolved by ruling 7 | `models.js:53-67`: the 200 MB iOS ceiling is "derived from reported failures rather than measured on hardware" |
| A14 | To confirm while fixing | — |

### A note on the mobile bar

The phone bar is a scrolling strip with a pinned `⋯`; `mobileNavFit.test.js`
records that five entries fit at 375 px and six scroll. Ruling 2 gives an
administrator six primary entries (Dashboard, Discover, Calendar, Messages,
Welly, Admin) — the same count an owner already has. That is the owner's own
second option in FX-12 ("scrollable horizontally … scrolling reveals the three
dots"), but the fit guard has to be updated deliberately rather than tripped.


---

## Phase 2 — Runtime verification (in progress, paused 2026-09-30)

Started on a throwaway database with every outside service switched off (Better Stack, tracing, Pinecone, Amplitude, Upstash, Resend/SMTP), so no quota was spent and no mail was sent. Findings so far, verbatim from the working notes:

## Findings
- A11 runtime proof: grant-ownership promoted two example.com addresses without objection.
- W1 Welcome.jsx:141/147 "Your information is only shared with the organizers of shifts you apply to." FALSE since public profiles (P2-18). Published, signed-out. Posture B.
- W2 index.html has an empty #root: blank dark screen until the bundle runs. Add an inline pre-mount placeholder (brand tile) — FX-52.
- W3 "Run by {SCHOOL_NAME}" renders when VITE_SCHOOL_NAME is set without "WeVolunteer" — false under Posture B. Owner-action: check production build env.
- W4 Login email placeholder truncated at 375px ("…your usernam").
- CK-11 MISREAD like CK-12: "Waiting on a reply" section (VolunteerDashboard.jsx:279-300, only when pending>0) renders ABOVE the hours card. Owner asked hours box above it. a5bbf6c swapped strip tiles instead. Fix: move hours card above Waiting section; restore tile order Upcoming / Awaiting reply / Shifts completed.
- FX-30 leftover confirmed at runtime: dashboard "Browse opportunities".

## Confirmed visually (Done·V)
- FX-52 welcome renders at 375 (after dev compile); FX-56 login fits, MS logo contained.
- FX-39 confirmed shifts: View / Can't make it only.
- FX-11 next-shift card: muted brand green in dark mode.
- FX-18 root cause read: dash-split collapses under the two-column width.
- Mobile bar student: Dashboard, Discover, Calendar, Messages, Welly, More — fits 375.

## Needs lived-in data (recheck after Phase 3)
- FX-31/32/65/66 caps; FX-34 badge ordering; P2-26 charts; CK-11 with pending apps.

### Phase 3 spike — PASSED

`server/simulation/lifecycle.sim.js` (run: `npx vitest run --config vitest.simulation.config.js`) drives one event from creation to certificate through real routes with only `Date` faked: early QR refused, code at shift start, scan, credit, close-out, lock refuses a later change, certificate issued. 1.4 s. The week rehearsal will be built the same way; the fallback is not needed.

**Next:** build `server/simulation/weekInTheLife.sim.js` (payload shapes for organizations, kick/ban `{mode, reason}`, appeals `{subject: organization_ban, organizationId, statement}`, reports `{targetType, targetId, reason, details}`, suspend `{reason}` already mapped), then finish the Phase 2 walkthrough on its lived-in data, then Phase 4 fixes.


---

## Phase 3 — The week in the life (run 2026-09-30)

`server/simulation/weekInTheLife.sim.js`, run by
`npx vitest run --config vitest.simulation.config.js` — deliberately outside
`npm test`. It moves `Date` (never the rows) through seven simulated days
ending yesterday, and every write goes through a route a person could call.

**Cast:** 100 students (grades 9–12, a third in private mode), 10 organizer
sign-ups (7 approved, 1 denied, 2 left pending), the demo organizer and
administrator, and two owners — one of them "Mahit", who is also a student and
both applies to events and hosts one.

**What they did:** 200 friend requests (152 accepted); three clubs (open,
request-to-join, invite-only by share link) with 66 memberships;
announcements, replies, and the replies switch turned off and on; 20 events
over five days with tags, club links, one not-for-credit and one Auto Select;
449 applications against the 10-event pending cap; organizers accepting,
waitlisting and rejecting; withdrawals; removals the evening before a shift and
refused ones after it started; QR check-in (86 codes scanned), manual check-in
and no-shows; credit with left-early hour adjustments; close-outs and the lock;
80 messages in 40 conversations; 33 external-hours entries; a kick, two bans
(one without a reason, refused), a rejoin, an appeal, a duplicate appeal, an
appeal decision and a lifted ban; a report, a suspension that confined the
account, and a suspension appeal; certificate privacy between students and
public verification; and six upcoming events relative to today.

**Engines:** SQLite and PostgreSQL 17. Both **zero anomalies**; totals within
one attendance row of each other (row order differs between engines, which
changes who is first on a roster).

### Invariants — checked after every simulated day, both engines

| Invariant | Result |
|---|---|
| Hours ledger agrees with attendance (`verifyLedgerParity`, the app's own check) | Held every day |
| No shift over capacity | Held — 104 acceptances refused as "shift full" |
| No credit for a shift that has not started | Held |
| Pending-application cap (10 events) | Refused the 11th with `application_limit_reached` |
| Close-out lock | 15 of 15 post-close-out changes refused `409` |
| Removal after a shift starts | Refused every time |

### What the rehearsal found in the product

| # | Finding | Evidence | Severity |
|---|---|---|---|
| **R1** | **Every QR check-in code shows the volunteer's name, never their @username** — the owner's explicit request in P2-28. The route reads `req.user.username`, but `authenticateToken` builds `req.user` from a query that does not select `username` (`server/utils.js`), so the field is always undefined and the fallback always fires. Static reading graded this "present"; only running it shows the data never arrives. It is the only read of that missing field in `server/` | 86 of 86 codes, both engines; `attendanceRoutes.js:799`; `utils.js` `req.user = {…}` | Medium — a named owner request, silently not delivered |
| **R2** | An expired or unverifiable session is answered **403** "Invalid or expired token", where every other session failure is 401. The client compensates at its session probe (`api.js:500-512`), so in normal use nobody sees it; after a `JWT_SECRET` rotation, requests made mid-session would read "You do not have permission to do that" | `server/utils.js` `authenticateToken` | Low — auth-adjacent; *security-review* if changed |

**P2-28 is therefore reopened: Partial·V.**

### What the rehearsal corrected in the rehearsal

Recorded because a rehearsal that reports its own mistakes as product defects
is worse than none. First runs showed 271 anomalies; every one was traced:

- Deadlines fall 30 h before a shift, so applying on day 1 was too late for
  day-2 events — the app was right to refuse.
- Every event started at 09:00, so the app's overlap rule (correctly) blocked
  most applications and the pending cap was never reached.
- Payload vocabulary: join-request decisions are `accept`/`reject`, and the
  request id is `requestId` (`id` is the user); club-appeal decisions are
  `stands`/`reversed`; a share link's token lives in its `path`.
- A second appeal while one is pending returns `200 {duplicate: true}` with the
  existing id, by design — not an acceptance.
- Close-out needs *every* confirmed volunteer accounted for, including one
  promoted from the waitlist after a removal; the rehearsal now reads the live
  roster, as an organizer's screen does.
- The clock had moved backwards between events; the week is now one monotonic
  timeline per day.

### The lived-in database

The SQLite run leaves a copy of the week (126 accounts, 29 events, 449
applications, ~120 attended shifts, ~190 credited hours, 2,694 notifications)
for the Phase 2 walkthroughs, which resume on it.


---

## Phase 2 — Runtime verification (on the lived-in week)

The walkthrough resumed on a copy of the Phase 3 database, as a student (7
credited shifts, 2 awaiting a reply), an organizer who ran five events, a club
manager, and the owner — phone (375×812), phone sideways (812×375) and laptop
(1440×900). Every outside service was off. Certificates and transcripts were
printed to PDF through headless Chromium in both themes, with background
graphics off (the browser default), rather than judged from the stylesheet.

### Confirmed in the browser

FX-01 (403 is a full-screen takeover on a phone, a laptop, and a phone held
sideways — the button is on-screen at 291 px of 375, where the predecessor
found it 396 px below the fold) · FX-02 (the audit trail reads as sentences in
stacked cards on a phone; "kept for one year" is true — a retention worker
sweeps at 365 days and a trigger blocks every other delete) · FX-11 · FX-18
(root cause read) · FX-29 · FX-31/32/65/66 (caps of 3 and 5, same floor for
shifts and certificates) · FX-35/53 (printing isolates the document, and light
and dark print byte-identical PDFs) · FX-36 (transcript lists events) · FX-39 ·
FX-41 (newest message at the bottom of a real thread) · FX-46 (both names above
the lines) · FX-48/61 (signature on the line, "Founder of WeVolunteer") · FX-50 ·
FX-51 (the new-message control is a compact "+") · FX-52/56 · FX-63 (appeals
box at the bottom with its history) · FX-71/73 (one Manage button, menu with
Promote to Student Organizer / Remove / Ban) · CK-10 (banned list with Unban) ·
P2-41 (Welly Chat answered a student's hours correctly from her record) ·
P2-48 (starting a preview lands on the dashboard).

### New findings

| # | Finding | Evidence | Kind |
|---|---|---|---|
| **W1** | The signed-out Welcome page says "Your information is only shared with the organizers of shifts you apply to." Profiles have been public since P2-18, so this is false — and it is published, to parents, under Posture B | `Welcome.jsx:141,147` | Defect — copy |
| **W2** | `index.html` has an empty root, so the page is blank dark until the bundle runs — the "blank screen" FX-52 asked about, on a slow phone connection | `index.html` | Defect — add a pre-mount placeholder |
| W3 | "Run by {SCHOOL_NAME}" renders whenever a production build sets `VITE_SCHOOL_NAME` without "WeVolunteer" in it — false under Posture B | `Welcome.jsx:74,135` | Owner-action: check the production build env |
| W4 | The login field's placeholder is cut off at 375 px ("…your usernam") | Login | Polish |
| **N1** | A not-for-credit event (P2-20) shows "+0 hrs credited", "+0 hrs" in the service record, and issues a **certificate reading "0 hrs"** | dashboard, profile, `/certificates` | **Owner ruling** |
| **N2** | Discover shows the posted-count line twice for students — two lead paragraphs both render | `BrowseEvents.jsx:627,653` | Defect |
| **N3** | Discover's search box sits at 973 px on an 812 px phone — below the location banner, both counts, the organizations button and all of "Suggested for you". The owner asked for it "on top of the Opportunities page"; no recorded reason for the placement exists | `BrowseEvents.jsx` | Gap — FX-19 Partial |
| **N4** | Opening a conversation on a phone leaves the "Messages" page header above the thread and puts the reply box at 850 px, behind the tab bar — the one thing a person came to do is off-screen. Welly, on the same phone, pins its input correctly | `Messages.jsx`, `ConversationPane.jsx` | Defect — mobile |
| **N5** | The organizer dashboard's "Your volunteers" shows each student's **grade**, although all of them are in private mode, which the owner said hides grade | organizer dashboard | **Owner ruling** — organizers may have an operational need |
| **N6** | "Your volunteers" is uncapped — 22 rows here, hundreds for a busy organizer | organizer dashboard | Defect — the FX-31 cap principle |
| **N7** | The applicant row hides the "X of Y attended" counts until a volunteer has **4** confirmed commitments (`MIN_EVIDENCE`), showing "New volunteer" instead. That serves the owner's fairness concern (FX-33) and works against his raw-counts request (FX-24/P2-17) | `ApplicantReview.jsx:144`, `server/reliability.js:85` | **Owner ruling** |
| **N8** | The owner profile says "**Runs WeVolunteer for the district**" — false under Posture B | owner profile | Defect — copy |
| **N9** | At 375 px the sixth primary entry (the owner's "Admin") is clipped at the edge ("Ac…") before the pinned `⋯`. Ruling 2 gives administrators six entries too | phone bar | Defect — fit six |
| **N10** | Error pages show the drawn wordmark alone, not the tile + name lockup the owner asked for everywhere (P2-47) | 403 page | Defect — branding consistency |
| **N11** | A club page's member list is uncapped (39 rows) before the manager's tools | organization page | Defect — cap |
| **N12** | The transcript prints on a cream panel. An earlier fix read the owner's "print it without the white background" as "it printed as bare white paper" and added the panel on purpose; the words can equally mean "remove the box behind it". The PDFs he attached at the time are not in the paste | `index.css` `.transcript` print rule, `9a2465b` | **Owner ruling**, with the print in front of him |


### Rulings on the Phase 2 questions (2026-09-30)

| # | Item | Ruling |
|---|---|---|
| 15 | N12 / FX-47 transcript print | **Plain white, no panel** — the transcript prints straight onto the sheet; the certificate keeps its look. Reverses the cream panel added in `9a2465b`, which read the request the other way |
| 16 | N1 / P2-20 events without hours | **Participation certificate** — "Attended · no hours" in place of "+0 hrs", and a verifiable *Certificate of Participation* with no hours line |
| 17 | N5 grade in private mode | **Visible only to organizers the student applied to** — hidden from other students and the public |
| 18 | N7 attendance counts | **Always show "X of Y attended"**, with the "New volunteer" tag beside it under four confirmed shifts; the Reliable badge keeps its floor of four |

---

## Phase 4 — Fix pass: the work list

Ordered by consequence. Each item is one change with a regression test watched
to fail first, a screenshot for anything visual, and *security-review* where
marked 🔒.

**Security and data integrity**
1. 🔒 Ownership locked to the two owner addresses wherever `super_admin` is granted (A11, ruling 6)
2. R1 — the QR code shows the @username (`req.user` never carried it)
3. 🔒 R2 — an unverifiable session answers 401, like every other session failure
4. Seed split: a QA seed that refuses any real database by content, and the owner's demonstration-record tool with its exclusions (A8, decision 1)
5. A schema-shape check an operator can run against production, and the missing CHANGELOG entry for migration 055 (A12)

**Broken or contradicting the owner's words**
6. Dashboards: organizer strip above the close-out card; student hours box above "Waiting on a reply"; both tile orders restored (A1, CK-11, CK-12)
7. Published claims that are false: Welcome (W1) and the owner profile's "for the district" (N8)
8. Phone messaging: thread full-height, reply box pinned (N4)
9. Discover: search at the top (N3), count once (N2)
10. Small defects: A2, A3, A4, A5, A9, W2, W4
11. Caps on long lists: organizer "Your volunteers" (N6), club members (N11)

**The owner's rulings**
12. Naming everywhere (ruling 5, A10)
13. Admin Calendar and a six-entry phone bar that fits (ruling 2, N9)
14. Account menu of four and the dashboard "Log external hours" button (ruling 3)
15. Certificate vs transcript: one summary document, explained (A7, FX-45); plain-white transcript print (ruling 15)
16. No-hour events: "Attended · no hours" and a Certificate of Participation (ruling 16)
17. Applicant rows: counts always, reliability hover text, first-timer badge (rulings 4, 18); grade visibility check (ruling 17)
18. Suspension: red border over a static backdrop (ruling 1)
19. Date picker everywhere, calendar jump-to-date (ruling 8)
20. Welly: offer banner, iPhone opt-in, precise disclaimer (rulings 7, 14)
21. Install prompt (ruling 9)
22. Lockup on error and public pages (N10)

**Requested, never built**
23. SEO: per-page descriptions, `robots.txt`, `sitemap.xml` (FE-02)
24. Report-a-problem screenshots (FX-75)
25. Identity-based owner profile and the `@mahit` guarantee (FX-09/10)
26. Headline impact figure (P2-09); un-approve an organizer (P2-12); report appeal spam (FX-70)
27. Google Calendar link (P2-04); send a certificate by direct message (SC-04); Owner Center checks for sign-in providers and Cloudflare (SC-09)
28. Photo OCR for paper certificates (P2-31)
29. Legal drafts for the owner to publish: the Acceptable Use Policy (ruling 13) and the "review changes" clause (FX-44)
30. Stale documentation and dead code (A14)

### Progress (2026-10-01)

| # | Status | Commit(s) | Notes |
|---|---|---|---|
| 1 | Done | `5e231cd` | *security-review* run before commit |
| 2 | Done | `0e74e2a` | R1. Passed the combined *security-review* below: the fix adds `username` to the session's user |
| 3 | Done | `5784b79` | R2. Passed the combined *security-review* |
| 4 | Done | `bb32bdb`, see 25 | The QA seed refuses real data by content. Ruling 19 replaced the demonstration-record tool with a showcase drawn on the profile, so nothing is written and no marker exists to exclude |
| 5 | Done | `cc886fb`, `eeb5e56` | `eeb5e56` builds the reference in memory: the first version deleted a temp directory and failed the script-safety guard |
| 6 | Done | `7c9cad1` | |
| 7 | Done | `ef96802` | |
| 8 | Done | `4b8c746` | |
| 9 | Done | `44de711` | |
| 10 | Done | `8f656b2` (A2), `290552e` (A3, A4), `f20f4ab` (A5), `381f374` (A9), `b7375bc` (W2), `11f5803` (W4) | |
| 11 | Done | `a1ec7c9` | Also fixed: the members page redirected to the club page; the count included suspended accounts (39 over a list of 38); the roster was capped at 100 with no way past it. The `?membersFrom=` paging sits behind the existing roster gate. Passed the combined *security-review* |
| 12 | Done | `e01e550` | `ownerNames.test.jsx` pins one name per page across hub tile, page title and Welly |
| 13 | Done | `a339315`, `fa5cb5e` | Administrators get Calendar, showing every platform event (it showed only deadlines before); six entries fit from 360px. `fa5cb5e`: the phone bar's overflow fade had never been set on a real network |
| 14 | Done | `8f656b2` | Account menu of four; "Log external hours" button on the student dashboard |
| 15 | Done | `c32be23` | The third document is gone; the transcript prints white. The print rule had never applied (the screen rule outranked it), so the cream panel was the screen rule all along |
| 16 | Done | `3373f79` | Certificate of Participation on screen, in the PDF and on /verify; "Attended · no hours" on dashboard, profile and transcript |
| 17 | Done | `c237410` | Ruling 17 verified without change: grade is gated on hosting or `user.contact.read` |
| 18 | Done | `17e6b86` | Silhouette backdrop, never the live app |
| 19 | Done | `ac5ee35` | Also: `.field-row` second columns sat 16px low everywhere |
| 20 | Done | `0c35281` | iOS Balanced under a 512 MiB experimental ceiling, opt-in |
| 21 | Done | `4c4bb09` | PNG icons and an apple-touch-icon added; the button appears only when the browser offers installation |
| 22 | Done | `c16a584` | `Wordmark` is now rendered nowhere; kept for the revamp hand-over |
| 23 | Done | `48cc211` | robots.txt, sitemap.xml, per-page descriptions; `noindex` on every page that carries a person. Search Console verification is an owner action |
| 24 | Done | `11cd2c5` | Also N13: reports had no staff view at all; `/admin/issues` added. Migration 072 |
| 25 | Done | `152aab1`, this commit | `@mahit`/`@wevolunteer` reserved; the platform account's wording fixed. Rulings 19 and 21: the founder's page is a student's at any history (`distinction.studentProfile`), and carries every badge and milestone as a labelled demonstration that writes nothing (`server/demonstrationShowcase.js`). `/api/users/:id/profile` admits the founder at zero service; every other account answers as before. *security-review* with the rest of this round |
| 26 | Done | `cd8638b`, `125d645`, `d41eecd` | Revoked organizers are their own state (migration 073), never deniable; appeal spam reported through the appeal, never the appellant's id |
| 27 | Done | `08b5a8a`, `b75a16b`, `4684d90` | |
| 28 | Done | this commit | Ruling 20. Tesseract.js on the device, loaded only for a photo, every file from this origin (about 7 MB); organization, activity and date filled and marked "Read from the photo", hours never. Verified in the browser against a generated JPEG certificate: text read exactly, no request to any CDN. Both builds verified (`bin/verify-ai-bundle.mjs`, now matching the OCR files). Not covered: a scan inside a PDF, which would need PDF pages rasterised. The AI policy (and its 2.0 draft) does not mention the certificate reader at all, before or after this |
| 29 | Done (drafts) | `45ff705`, `e10568e`, this commit | `docs/legal/drafts/`. Unpublished; the owner publishes. Ruling 22 added `end-user-licence.md`, limited to what reaches a device |
| 30 | Done | `c832dd1` | |

**Rulings on the fix-pass questions (2026-10-04):**

| # | Item | Ruling | Consequence |
|---|---|---|---|
| 19 | Item 4 / decision 1, the showcase | **Drawn on the profile only** — supersedes the marked demonstration rows | The founder's profile shows every badge, hour and streak under a "demonstration" tag; nothing is written to attendance, so the transcript, certificates, `/verify` and every platform total stay true without touching the 26 files that read attendance. The QA seed (`bb32bdb`) stays as it is |
| 20 | Item 28 / P2-31, photo reading | **OCR, but never the hours** | On-device OCR pre-fills organization, event and date from a photo; the student always types the hours, so the misread that lands on a record cannot happen. Language data self-hosted, loaded only when a photo is chosen |
| 21 | Item 25, the founder's page | **Student-style always** | The founder's profile uses the student layout whatever the history, with honest zeros; every other account keeps the history-driven layout |
| 22 | Ruling 13, EULA | **Draft one** — the recommendation was none | An EULA draft in `docs/legal/drafts/`, unpublished, for the owner to review against Posture B before publishing |

**Combined *security-review* — passed 2026-10-04, no findings.** Run over the
whole diff ahead of `origin/main` at `d4cd8fb`, with these nine commits read
first: `0e74e2a`, `5784b79` (session middleware), `a1ec7c9` (roster paging on a
privacy-gated route), `3373f79` (the public verify endpoint gains a field),
`11cd2c5` (uploads and a staff-only image route), `152aab1` (signup and
rename), `125d645` (organizer revocation), `d41eecd` (report from an appeal),
`4684d90` (outbound checks). Nothing reached the reporting bar (medium or high,
confidence 0.8 or more). What each rests on, so a later change knows what not
to break:

- *Roster paging:* `membersFrom` is an integer clamped to 0–999,999 and bound
  as `OFFSET ?`; `mayReadRoster` still decides whether any row is returned.
- *Appeal report:* `organization.manage.own` plus `loadManagedOrganization`;
  the appeal lookup is scoped to `subject_ref` = this club, the reported user
  is resolved on the server, and `createReport` refuses self-reports.
- *Screenshots:* anybody but the reporter gets the same 404 as a missing
  report; fifteen minutes, three images (the primary key enforces it too),
  re-encoded to WebP; reading needs `report.resolve` and is `no-store`.
- *Reserved handles:* checked at both signups, `check-username` and
  `change-username`, against the stored email, never the request's.
- *Revocation:* all three routes need `organizer.approve`; Deny skips revoked
  accounts and refuses any with events; event creation still reads `verified`.
- *Verify endpoint:* gains one boolean from the event's `credits_hours`.
- *Owner Center checks:* two fixed discovery URLs, no credentials sent, results
  reduced to a status word for `owner.console` holders.
- *Session:* only the status of a failed verify changed (403 → 401); the
  preauth and `token_version` checks are untouched.

The commits another session landed afterwards (`d3f9cb6`…`516bba3`, privacy
defaults and Welly) are outside this review; Phase 6 reviews the whole
engagement's diff again.

**Second *security-review* — passed 2026-10-04, no findings.** Every code
change after `d4cd8fb`: this round's `6a4c6c2` (founder profile) and `d989b2b`
(photo reading), and the other session's `6bad3f9`, `aed176c`, `21f70ad`,
`3c9de47` and `9784067`. What the two from this round rest on:

- *Founder profile:* `/api/users/:id/profile` still answers 404, with the same
  body, for every account that answered 404 before; the one addition is
  `studentProfile`, a server constant chosen by stored role *and* address
  (`super_admin` with `FOUNDER_EMAIL`). A student who registers that address
  gets nothing. The response is built field by field, so `is_volunteer` and
  `users.*` never leave the server. The showcase is badge definitions and
  milestone tiers, with no user data.
- *Photo reading:* the dev-server middleware serves one file fixed at config
  time; the request path never reaches the file system. Worker, engine and
  data are same-origin, so the production CSP needs nothing relaxed
  (`worker-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`,
  `connect-src 'self'`), and a CDN fallback would be blocked by `connect-src`.
  OCR text reaches form fields only.

Full suite at `d989b2b`: 11,481 passed, 1 failed: `thirdPartyNotices.test.js`,
because `tesseract.js` was missing from `THIRD-PARTY-NOTICES.md`. Fixed in the
next commit, with Tesseract's engine, its bundled libraries and the English
data, which a dependency scan would not have listed.

Full suite at `ac5ee35`: 11,227 passed, 0 failed.

**For the revamp hand-over (Phase 7):** on a phone, the organizer's volunteer
row gives the name about a third of the width. It wraps now rather than
truncating, but the row would read better with the pill and Profile on a
line of their own.

---

## Phase 5 — Coherence: "is this the app I imagined?" (2026-10-04)

The app walked as four people arriving for the first time, on the lived-in
scratch database: **a new student** (signed up through the form, confirmed the
email, applied to a shift, opened every tab), **a new organizer** (signed up,
pending, approved, Organizer Agreement, first event), **a club lead** (a
manager of a 38-member club) and **an administrator**. Then compared with the
SignUpGenius dashboard in `SignUp Genius/` (Create · Dashboard · Groups ·
Messages · Reports · Tools · Admins): reminders (24 h and 2 h), duplicating
an event, a waitlist, a roster export, check-in and calendar links all have an
equivalent, so the gaps found were in flow and wording, not features.

### Fixed in the walk (defects: wrong whatever was intended)

| # | What the walk met | Fix |
|---|---|---|
| C1 | **A signed-in student opening Messages read "Messaging is not available for this account".** The page chose its copy from a cached user that only the password, two-factor and signup calls wrote; a session that began any other way (Google or Microsoft sign-in, an email link, a returning visit) left it empty. It also went stale after an approval or an accepted agreement. *Live in production for every Google sign-in.* | `b8a3e92`: the session probe writes the cache too. *security-review* (session state) |
| C2 | An approved organizer pressing "New event" before accepting the Organizer Agreement was told "your organizer account has not been approved yet … nothing else is needed from you" — three false statements, and no mention of the agreement | `7273e05`: the shell says *why* a route was refused; a paused capability names its agreement, with a button |
| C3 | Eight strings said **school staff** run WeVolunteer (organizer "verified by school staff", a pending organizer waiting on "a school administrator", the private profile option "Only me and school staff", Welly's description of administrators, two dead ends saying "contact your school administrator"). The Privacy Policy says administrators are the operator's appointees; Posture B | `8ef96e3`, with a guard (`schoolStaffClaims.test.js`). The approval notice said "You can now post events" while posting still waited on the agreement; it now opens the agreement |
| C4 | A newly approved organizer's dashboard opened on "Your organizer tools are **paused** … restores everything" — the wording of a suspension, for tools never held. The banner was a link that did not look like one | `7b0fd86` |
| C5 | A club page told its manager "Post an opportunity and it will appear here" and offered no way to; the form then made them pick the club again | `1a23792`: the button, and the form opens with the club chosen |
| C6 | The Legal Center rendered `*italics*` with their asterisks (the Organizer Agreement's acceptance block) and "[ ]" before each agreement's confirm list, above the real checkboxes | `6fefbe2`: presentation only; no document text or hash changes |
| C7 | "Programme"/"organisation" beside "Organization" in nine places; a profile placeholder suggesting "the district volunteering programme"; an invalid CSS value on the student dashboard | `4b56910` |

### For the owner — changes that alter a choice somebody made

Ranked by how much a first-time user trips on it. Nothing here is changed
until ruled on.

1. **One noun for the thing an organizer posts.** On two adjacent screens it is
   "New event", "Create your first event", the page title "New opportunity" and
   the button "Publish sign-up sheet"; Discover says "opportunities", cards say
   "View shifts" or "View sign-up". Recommendation: "event" in every organizer
   tool and button, "opportunity" only where a student browses, and "sign-up
   sheet" retired.
2. **A new student's first sight of their own record is a red "0 hrs".** The
   hours figure is coloured by progress to the 25-hour target: red under a
   third, amber under the target, green after. Red reads as failing to a
   student who has not started, and the design notes reserve amber for hours.
   Recommendation: hours always in the hours colour; progress shown by the
   meter alone.
3. **Small placement and wording**, each a few lines:
   - the "See how far away opportunities are" location banner also shows on an
     *organizer's* dashboard, whose job is posting;
   - a club's manager sees "You are a member" on their own club, and a "Your
     service here" card meant for volunteers;
   - a pending organizer's page subtitle reads "Track your volunteers, hours,
     and pending reviews", none of which they have yet;
   - signup emails the "Early Supporter" badge in the same minute as the
     address-confirmation link, to an address not yet confirmed;
   - on the signup form, validation hints appear under each field while typing
     and push the "Create account" button down under the pointer;
   - an admin's report card shows the reported person's name twice.

**Rulings on the Phase 5 questions (2026-10-04):**

| # | Item | Ruling |
|---|---|---|
| 23 | Naming | **"Event" in every organizer tool and button; "opportunity" only where a student browses Discover; "sign-up sheet" retired** |
| 24 | Hours colour | **The hours figure is always the hours colour**; progress to 25 hours is the meter's job |
| 25 | Small fixes | **All of them**: location banner off organizer dashboards; a manager sees "You manage this organization" and no volunteer-only card on their own club; a pending organizer's subtitle fits; the badge email waits for a confirmed address; the signup button stays put; a report card names the person once |

Deliberately left as found, with the recorded reason: "Microsoft — not set up
on this site" on the signup screen (`ProviderButtons.jsx`, the AADSTS900144
incident), and "Verify a certificate" on every dashboard (requested by the
owner, `VerifyCertificateAction.jsx`).

**Applied (2026-10-04):** ruling 23 `5dbd8c0` (also: Discover's subtitle said
"across the district"); ruling 24 `6c90e5c`; ruling 25 `93d2967` — six fixes,
including one wider than asked and worth knowing: *no email but the
confirmation link now goes to an address nobody has confirmed* (the badge
email was one case of it), only while `REQUIRE_EMAIL_VERIFICATION` is on, and
mandatory notices excepted.

**For the security review of this phase:** `b8a3e92` (the session probe
writes the cached user) and `93d2967` (who is emailed).

---

## Phase 6 — Unfinished work, the final audit, and the ledger closed (2026-10-04)

| Check | Result |
|---|---|
| TODO / FIXME / "coming soon" sweep | Clean. The one "coming soon" is the filtered state of an unbuilt sign-in provider (Apple), never shown |
| Code review of the whole engagement diff (`origin/main...main`, structured by module: server routes and services first, then client logic) | 5 findings, all fixed: three tests left on the old word "opportunities" (`36b8f7e`); a cleared time sent half a date that the edit form could not save (`7c6face`); an abandoned photo read left its worker running (`77223f2`); an appeal-spam report could fail the report limit (`04b7c30`); a revoked organizer was promised a review that never comes (`d8baa65`) |
| *security-review*, third pass (`e97ad10..HEAD`) | No findings. The two before it: none |
| Full suite, SQLite (`d8baa65`) | 11,530 passed, 0 failed, 178 skipped |
| Full suite, PostgreSQL 17 (`a06d021`) | 7,427 passed, 0 failed, 41 skipped. The first run had 21 failures in `migrations.postgres.test.js`: its hand-built version-56 database lacked a table every real one has, which migration 072 references, and one assertion had listed the migrations by hand since 067 and been failing, unrun, since 068. Both fixed in `a06d021` |
| Week rehearsal, re-run | SQLite and PostgreSQL 17: **zero anomalies** on both. 126 users, 449 applications, 119 attended, 191 / 189 hours (row order differs between engines, as in Phase 3) |
| Accessibility sweep (`npm run a11y`) | 62 passed, 3 failed: the calendar toolbar scrolled sideways at 320 px once it carried "Go to date" (fixed `66aab75`), and the new members page has no seeded club to measure (recorded in `SWEEP_CANNOT_MEASURE`, like its parent page). Re-run: 6 of 6 |
| Build, bundle secret scan, AI-bundle gating | Clean; clean; PASS with the OCR files matched |
| Owner walk in the browser | Role preview, Owner Center (with the new sign-in and Cloudflare checks), Platform Impact's headline, About, the Legal Center, data export and deletion, the event modal's spacing. Turned up the last British spellings (`9d724fc`) |

**How the code was covered.** A literal line-by-line reading of all ~1,170
files was not done, and is not claimed. The engagement's own diff was read
in full by module (inputs, authorization, persistence, error paths); the
untouched remainder rests on the 09-21 audit, the suites, the rehearsal and
the walks.

### The ledger, closed

Every row has a final status and the evidence that settled it (the
"**Final:**" note on each). 171 rows:

| Status | Rows |
|---|---|
| Done·V | 152 |
| Done·V (owner-accepted) | 6 |
| Owner-action | 2 (EM-01 sender avatar; FX-44 publishing the clause) |
| Deferred by the owner | 3 (P2-50 attachments, SC-05, FE-01 the revamp) |
| Partial·V | 1 (LG-01: the manual screen-reader pass) |
| Done·R, the owner to judge | 1 (P2-35: Welly's answer quality on the running model) |
| Declined by the owner | 1 (LG-03) |
| Superseded | 1 (FE-05) |
| Duplicates | 4 |

Nothing stays *Reported*.

---

## Phase 7 — Revamp hand-over

Written: `docs/audits/2026-10-revamp-handover.md` — the design as it stands
(tokens, the two motion systems, the brand lockup, the two sites), the visual
requests that still want a visual answer, the eleven rules a revamp has to
keep, and what it needs from the owner.

**The audit is complete.** Everything is committed locally on `main` and
nothing is pushed or deployed; the owner actions above are what remains.

---

## Phase 8 — Publish, try Welly AI, deploy (2026-10-05)

The owner asked: publish the legal drafts, try the AI, set up Search Console,
then deploy if everything is perfect.

### Published

- **Acceptable Use Policy** (policy 14) and **End-User License** (policy 15),
  `notice` documents taking effect 2026-11-06 (`d1b5458`). Two departures from
  the approved drafts, both in the policy files' specification blocks: six
  rules and promises from Terms §4 that the AUP draft had dropped were
  restored, so moving the rules to the AUP changes none of them; and the EULA
  was corrected against the code (the two models offered, their sizes, the
  remove button, the footer sentence) and spelled "License".
- **Terms 2.0.0** staged for the owner (`docs/legal/drafts/terms-of-service-2.0.body.md`):
  §4 points to the AUP, §8 links the End-User License, §13 adds the reader's
  responsibility, corrected to say the legal email always goes (it is a
  mandatory notice) and to list what is actually withheld until acceptance.
  A dry run of the editor's own validation accepts it for 2026-11-06.
- Every version line said "in effect since", including for a document not yet
  in effect; it now says "takes effect" until the date arrives (`01523ef`).

### Welly AI, tried

Desktop Chromium on the local app, Balanced (Qwen2.5 0.5B, 469 MB from Hugging
Face; the download ran at Hugging Face's ~0.25 MB/s, measured separately).
Setup, the footer, the policy wording, "Turn off and remove", hours, Auto
Select, a confirm-first action and its cancel all behaved. Three wrong answers,
all ours and not the model's, fixed with tests (`9f038b2`, `e3add65`):

| Asked | Got | Cause |
|---|---|---|
| "Are there any river cleanup events I can join?" | "I couldn't find any" with River cleanup #3 open | "join" stayed in the search terms |
| "How many hours does Leo Chen have?" | The asker's own record, "0" | The refusal knew "their" and "someone else", not a name |
| "Change my bio to: I love helping…" | A card saying only "Update profile (bio)", over a bio of "to: I love helping…" | The pattern needed a space after "to", stopped at any apostrophe, and the card hid the value |

The setup dialog also said "data centre"; a source-reading guard now holds the
whole client and the email copy to American spelling (`d173043`, fifteen
strings). The model's free-form advice is generic but harmless (P2-35 stays the
owner's call).

**The iPhone Simulator, later the same day** (Xcode and the iOS 27.0 runtime
installed by the owner; iPhone 18 Pro, Safari 27). Setup offered Balanced with
the "experimental on this device" warning and its checkbox, as ruling 7 asks,
and the 469 MB download completed. Then every question sat on "Thinking" with
the page idle. Two defects, both fixed with tests:

| Found | Cause | Fix |
|---|---|---|
| Welly AI never answers in Safari | wllama's engine build is 64-bit WebAssembly (Memory64). Safari passes wllama's own feature check but cannot compile the module, so the worker aborted, wllama's abort handler threw before rejecting, and the load never settled. Every browser on iPhone and iPad is WebKit, and so is Safari on a Mac, so ruling 7's experiment could not have worked | `7da9673`: Welly AI is not offered where a Memory64 module will not compile, with the reason shown; the runtime refuses early and bounds the load. The unpublished AI policy 2.0 body is corrected to match |
| Tapping the Welly composer zooms the page | Its text was 15px; iOS zooms on focus below 16px. Measured: four more fields | `131966c`: all five at 1rem on touch screens, and a stylesheet guard |

**Then the owner said: fix all, using the recommendations.** The
recommendation was to make Safari work rather than withhold it, and it did
(`b2d50d6`): wllama's own compatibility engine (`@wllama/wllama-compat`
3.5.1, no Memory64, slower), self-hosted, chosen wherever a Memory64 module
will not compile. In the Simulator the model loaded in 2.0 s, a one-line
reply took 3.3 s (Chrome: 0.4 s) and a real six-point Welly answer about
35 s. iPhone and iPad stay ruling 7's experiment, its warning now also saying
replies are slower; the AI policy 2.0 body went back to the approved text,
which is true again. A real iPhone's memory limit is still the open question.

Also fixed in the same pass, each with tests:

| Found | Fix |
|---|---|
| "Find food bank events this weekend" searched every date | `1e1f8e2`: "today", "tomorrow", "this/next weekend, week, month" become the events API's `from`/`to` |
| "What food pantry events can I apply to" answered "I can't help with that one" | `1e1f8e2`: a search, held to the thing asked for, so "Can I apply to more than five events at once?" is not |
| "Update my headline to …" drafted a bio change | `f858016`: the headline is its own field; "about you" (the bio's label) now counts |
| `.form-input` styled no element | `1d8e2f0`: removed |

The security review (the skill, over all 100 commits ahead of `origin/main`)
found nothing at or above its confidence threshold; the headline row above is
the one functional bug it noticed.

### Deployed again: `1a60b45`, 2026-10-06 01:38 UTC

Gates on the release commit: `npm test` 723 files / 11,590 passed; `npm run
a11y` 65 passed; lint (after renaming a helper the hooks rule read as a Hook,
`1a60b45`), build, `scan:bundle`, `verify-ai-bundle` and the secret scan clean;
no server change since `e3add65`, so its PostgreSQL run stands. Snapshot
`wevolunteer-20261006T013725Z` (migration 75) verified on B2 first. Build, swap
and verify passed; no migrations; the 15 legal pins verified at boot. The
production assets include the 14 MB compatibility engine, served as
`application/wasm`. Previous release kept at
`/srv/wevolunteer-prev-e3add65-20261006T013817Z`; with no migrations in this
release, a plain `provision.sh rollback` is enough.

### Finishing (2026-10-07/08)

- **Legal:** the owner signed in to the built-in browser; Terms 2.0.0
  (effective 2026-11-06) and AI policy 2.0.0 (effective 2026-10-07) were
  published through the editor, each verified byte-identical to its committed
  draft. Both drafts first lost their British spellings and Terms 1.0's stray
  last line (`cb1ef28`).
- **The editor's hint** said italics would "appear literally" though they have
  rendered since Phase 4 (`c3da244`).
- **Search Console:** the property already existed; the app sitemap was
  submitted and reported "Couldn't fetch", because robots.txt ended in
  `Disallow: /` with no Allow for the sitemap it names (`283b9d7`). Cloudflare
  caches robots.txt for four hours, so Google sees the fix by the next read.
- **The Mac's disk filled** (ENOSPC) from 8.4 GB of swap built up by a booted
  iPhone Simulator; at the owner's request Xcode, the iOS runtime and all
  simulators were removed.
- **Deployed `283b9d7`** (2026-10-08 02:55 UTC): `npm test` 723 files /
  11,592 passed, lint, build and bundle checks clean, snapshot first, verify
  passed, no migrations.

### Search Console — not done

Claude in Chrome was not connected at any point (no browser registered to the
account). The app's sitemap is now live as XML (21 URLs), which it was not
before this deploy: production had been answering `/sitemap.xml` with the app's
HTML. The info site's sitemap is live (7 URLs).

### Deployed: `e3add65`, 2026-10-05 20:05 UTC

Production was on `b49ec35` (2026-09-29), not the `98b3f63` the notes said;
91 commits went out. Gates on the release commit: `npm test` 722 files /
11,561 passed; `npm run test:postgres` 434 / 7,443 passed (no server change
after that run); `npm run a11y` 65 passed; lint, build, `scan:bundle`,
`verify-ai-bundle`, the secret scan and the checklist's greps clean.

Snapshots before the swap, encrypted, uploaded to B2 and verified byte-identical:
`wevolunteer-20261005T152355Z` and, after a pause, `wevolunteer-20261005T200440Z`
(migration 71, 4 users). An unswapped `66aab75` release found in the staging
directory was moved aside to `/srv/wevolunteer-unswapped-66aab75-20261005`,
not deleted. Build, swap and `verify` passed; migrations 072–075 applied on
PostgreSQL; 075 re-synced the Youth Safety Guidelines; "15 published documents
verified against their pinned hashes". The previous release is kept at
`/srv/wevolunteer-prev-b49ec35-20261005T200457Z`.

**If this ever has to roll back:** `provision.sh rollback` alone would not
boot, because the database now holds the new Youth Safety hash. Delete that
one unaccepted row (`legal_documents`, `youth-safety-guidelines` 1.0, as 075
does) before starting the old release, or restore the 20:04 snapshot.

## Phase 9 — Privacy Policy 2.0, and what checking it found (2026-10-12)

The owner asked for the two remaining owner actions: Privacy Policy 2.0 through
the Legal Center editor, and accepting the Admin Responsibilities Policy on the
owner account. Drafting 2.0 meant checking every recipient the policy names, or
should name, against the live host — environment variable names only, never
values — and four of 1.0's statements turned out to be false in ways that were
better fixed than reworded.

### Fixed in code (deployed as `82f74ef`)

| Commit | What 1.0 said | What was true | Fix |
|---|---|---|---|
| `d17e0e5` | "Your coordinates are never stored — not … in a log" | nginx logged in Ubuntu's `combined` format, query strings included. Eleven reset links with their tokens were in the 14-day logs (all expired: requests from 2026-09-27, tokens live an hour); no coordinates had been logged yet | `log_format wevolunteer_noquery`: the path without its query, the Referer cut at `?`, in both server blocks. Checked live: a marker in a query string and in a Referer was not logged |
| `462bed7` | The Cookie Notice: nothing about how you use WeVolunteer reaches anyone but Cloudflare unless you switch it on | `index.css` imported Bricolage Grotesque and Public Sans from Google Fonts on every page | Self-hosted from the Fontsource packages (OFL-1.1, pinned); CSP `style-src` and `font-src` are `'self'` only. Checked live: both faces load from `/assets/`, no Google request |
| `718628f` | Everything except hours, certificates and safety reports has an end date | `security_audit_logs` (two-factor events, with IP address and browser) was never swept, and survives account deletion while the shell carries hours | Swept daily on the admin audit log's one-year period |
| `c52cd84` | The Upstash code "cannot be turned back into your email or your address" | `hashSegment` was a plain SHA-256: an IPv4 address is recoverable by hashing all 2³² | HMAC-SHA256 under a key derived from `JWT_SECRET`; rotating that secret resets Upstash's counters and caches once |

`security-review` over the four: no findings.

### Found and disclosed rather than changed

Supabase (AWS us-east-2, Ohio), Oracle Cloud (us-ashburn-1), Backblaze
(us-east-005, encrypted, 28 days) and Better Stack (eu-central-1, Germany, 3 days)
were unnamed; Upstash is in AWS us-east-1, not India (3 ms from the host);
CARTO receives nothing since the tile proxy; OpenRouteService is not configured
in production; an organizer's address search sends Nominatim a viewbox around a
position rounded to about 11 km. The draft is
`docs/legal/drafts/privacy-policy-2.0.body.md` (`65d7add`): 2.0.0, effective
2026-11-13 (the floor on 2026-10-13 UTC is 2026-11-12), MAJOR, so every account
re-accepts on that date. It passes `validateBody` and `validatePublication`.

### Gates on `82f74ef`

`npm test` 724 files / 11,612 passed, after one fix: the async-shape ratchet read
a regex `re.exec` in the new nginx test as an unawaited database `exec`
(`82f74ef`, rewritten with `matchAll`, ceiling unchanged).
`npm run test:postgres` 435 / 7,459 passed. `npm run a11y` 65 passed. Lint,
build, `scan:bundle`, `verify-ai-bundle` and the secret scan clean.

### Deployed: `82f74ef`, 2026-10-13 01:54 UTC

Snapshot first: `wevolunteer-20261013T015324Z`, uploaded to B2 and verified
byte-identical. Build, swap (`nginx -t` passed, reloaded) and `verify` passed;
no migrations; "15 published documents verified against their pinned hashes".
Previous release kept as a `/srv/wevolunteer-prev-283b9d7-*` directory.

### Waiting on the owner

- **Admin Responsibilities Policy.** The seven undertakings are personal — one is
  the New Jersey mandated-reporter duty — so the owner ticks them; it was not
  done for him. Until then fourteen capabilities stay withheld.
- **Publishing Privacy Policy 2.0** needs the owner signed in for the editor's
  identity step. The production session had expired on 2026-10-12.
