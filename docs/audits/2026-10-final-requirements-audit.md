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
| FX-01 | 403 screen full-screen like 404/500; all error screens match, mobile + laptop | Done·R | `src/App.jsx:1939-1941`; `ErrorExperience/kinds.js` (`403: 'immersive'`) | Visual check in Phase 2 incl. landscape phone |
| FX-02 | Admin audit log styled properly | Done·R | `AdminAuditExplorer.jsx:213-243`; `index.css:9171`; `16b9867` | Sentences, severity, cards on mobile |
| FX-03 | Suspension splash: red border, blurred app behind, unescapable, reason shown, can sign out, no global sign-out | Partial·V | `App.jsx:~1662-1681` ("reverted, for three reasons"); `SuspendedWall.jsx`; `authRoutes.js:1678-1695` | Reason + per-device sign-out done. Blur deliberately reverted; no red border. **Gate** — Ruling 1: red border over static blurred backdrop |
| FX-04 | "New message" copy wrong for admins/organizers | Done·R | `components/messages/recipientCopy.js:60,87,122` | Copy derived from capabilities |
| FX-05 | One Admin / SuperAdmin entry instead of many | Done·V | `App.jsx:433` | Single "Admin" → `/admin/moderation` — P1: NAV table read: one Admin entry |
| FX-06 | "Create event" on the right of Opportunities for everyone who can; remove "New Event" from nav | Done·V | `BrowseEvents.jsx:593,691-694`; `App.jsx:397` | P1: NAV comment + Discover header |
| FX-07 | Owner pages only via the hub, never deleted: Community Impact, Appeals, Admin Roster, Audit Explorer, Errors, Platform Impact | Done·V | `ModerationCenter.jsx:77-140`; routes intact | Tile names ≠ page titles (see A10) — P1: all six routes registered; hub tiles present |
| FX-08 | Mahit persona switch: owner / admin / organizer / student | Done·R | `server/routes/personaRoutes.js:79-82`; `PersonaPreviewBanner.jsx:39` | |
| FX-09 | Mahit's handle is `@mahit`; delete any conflicting account; only two accounts matter | Partial·R | `bin/bootstrap-owners.mjs:77-78`; `server/config.js:414`; `accountValidation.js:119-137` | Nothing guarantees `@mahit`. **Deletion is Owner-action** — production holds real users; this audit deletes no accounts |
| FX-10 | WeVolunteer platform account gets a special owner profile | Partial·R | `App.jsx:184-189,215-218`; `profileSerializer.js:115,143` | Keyed on role, so both super_admins get the same treatment |
| FX-11 | "Your next shift" too bright in dark mode; match other greens | Done·R | `index.css:433,466,2208` | Eyeball in Phase 2 |
| FX-12 | Admin mobile bar: Dashboard, Opportunities, Calendar, Messages, Admin; overflow: Notifications, My profile; short consistent hub name; no detached separator | Partial·V | `App.jsx:392,2251-2345`; 09-21 Pass 15 6A | No Calendar — an audit choice, not the owner's. **Gate** — Ruling 2: add Calendar for admins (6A overturned) |
| FX-13 | Owner/partner preview selector UI cleaner | Done·R | `ModerationCenter.jsx:388,423-448` | Radio cards replaced `<select>` |
| FX-14 | External hours: tracking only, never verified; separate log page; not in nav | Partial·R | `LogExternalHours.jsx:285-295`; `LoggedHours.jsx:114,215-226`; `VolunteerDashboard.jsx:499-543` | Tracking-only + warning + back button done. See P2-21 for the button |
| FX-15 | RULE: no new menu-bar icons; entry points in existing surfaces | Done·R | — | Standing rule; checked across every item |
| FX-16 | Opportunities + Find merged cleanly | Done·R | `routes/index.jsx:273`; `BrowseEvents.jsx:104-109` | Visual check Phase 2 |
| FX-17 | Avatar menu exactly Profile / Notifications / Settings / Sign Out; mobile Profile in overflow | Partial·V | `ProfileMenu.jsx:146-185`; `accountMenu.js:70` | Extra "My hours" item. "Notifications" goes to *settings* on desktop, the *inbox* on mobile (A2). **Gate** for My hours — Ruling 3: exactly four items; A2 fixed as a defect |
| FX-18 | Dashboard zoom-out on mobile — investigate, fix only if real | Done·R | `index.html:38`; `e3c2190` | Zoom not blocked; sideways overflow fixed |
| FX-19 | People/org search inside Opportunities; no Edit Profile item; edit button on profile; same layout | Done·V (owner-accepted) | `BrowseEvents.jsx:804`; `VolunteerProfile.jsx:135` | Edit opens a modal. **Gate** — Ruling 12: pop-up kept |
| FX-20 | One logo in both themes; favicon; emails | Done·V (owner-accepted) | `BrandMark.jsx`; `public/favicon.svg`; `server/email.js:675` | Email tile draws a plain "W", not the checkmark-W (clients strip SVG). **Gate** — Ruling 12: letter-W tile kept |
| FX-21 | Desktop: Profile not in nav, lives in avatar menu | Done·V | `App.jsx:480,2027` | P1: Profile is `secondary`, `accountOnly` |
| FX-22 | Owners/partners get custom profiles; @mahit shows student info for colleges | Done·R | `App.jsx:215-218`; `VolunteerProfile.jsx:112`; `Distinction.jsx` | |
| FX-23 | `@` → only users; `#` → only tagged opportunities/orgs | Done·V | `BrowseEvents.jsx:249-300` | P1: sigil overrides type server-side |
| FX-24 | Applicants show events signed up and attended | Done·R | `ApplicantReview.jsx:208-225` | Counts, never % |
| FX-25 | Rename Opportunities tab, no longer than "Opportunities" | Done·R | `App.jsx:358` | "Discover". Organizers' page title says "Recruit" (FX-30) |
| FX-26 | About Us once, own non-heart icon | Done·R | `Settings.jsx:592-637` | `Info` icon |
| FX-27 | Org creation tags fail with "40 characters" | Done·R | `server/organizationTags.js:88-107`; `a9ded8d` | Root cause: `{tag,label}` objects |
| FX-28 | Check-in and finalize hours — do they work, when? | Done·V | `attendance.js:29-34,477-553`; `attendanceRoutes.js:280-304` | Close-out only after every shift ends and everyone is accounted for — P1: lock re-read `FOR UPDATE`; refused before any other check |
| FX-29 | Friends can message; copy says organizers **and** friends | Done·R | `messageRoutes.js:60-95`; `recipientCopy.js:123-125` | |
| FX-30 | `/events` → `/discover`; no naming discrepancies | Partial·V | `VolunteerDashboard.jsx:274,435`; `OrganizerDashboard.jsx:344`; `CalendarView.jsx:371`; `ai/navigation.js:58` | No `/events` links remain; "Browse/Find opportunities" labels and "Recruit" do. **Gate** (N-13 declined these) — Ruling 5: "Discover" everywhere, incl. organizer title |
| FX-31 | Dashboard service record capped + "show more" → page | Done·R | `VolunteerDashboard.jsx:556-561` | Cap 3 → `/hours` |
| FX-32 | Profile service record capped + "show more" | Partial·V | `VolunteerProfile.jsx:261-267` | Cap 5, but on someone else's profile the link goes to **your** `/hours` (A3) — P1: A3 confirmed: `moreHref="/hours"` regardless of `isSelf` |
| FX-33 | Reliable Volunteer as a badge beside applicants, hover text; fair model (history, recent, decay, recovery, volume); first-time and inactive badges; lost below 90%; not an achievement | Partial·V | `server/reliability.js:61-96,222`; `ApplicantReview.jsx:142-205,238-262`; `c2f5fff` | Badge + decay + evidence floor + withdrawal done. No hover text; first-time is a tag; inactive badge declined; smoothing means exactly 90% never earns it. **Gate** — Ruling 4: hover text + first-timer badge |
| FX-34 | Hour ladder 5…250+, streak badges, descending, interleaved, "show more" to a page; Early Supporter; other good achievements | Done·R | `server/scripts/seed_badges.js:103-218`; `utils/badgeOrder.js`; `BadgesList.jsx:126` | |
| FX-35 | Transcript and certificate print properly, light and dark | Done·R | `index.css:4397`; `printIsolation.test.js` | Tests parse CSS only — **print preview in Phase 2** |
| FX-36 | Transcript lists events (total hours each), not shifts | Partial·V | `VolunteerPortfolio.jsx:15-22,89,217` | Transcript done; a third document lists shifts (A7) — P1: A7 confirmed |
| FX-37 | Shift row cluttered | Done·R | `EventShiftsTab.jsx:239-314` | Icon buttons |
| FX-38 | Organizer map: normal theme, not high contrast | Done·R | `location/basemap.js`; `dba4001` | |
| FX-39 | Remove "Confirmed" pseudo-button from confirmed shifts | Done·R | `VolunteerDashboard.jsx:450-474` | |
| FX-40 | Location banner: permission checked each load; dismissed per session | Done·R | `LocationContext.jsx:49-161` | Safari fallback noted |
| FX-41 | Newest message at the bottom | Done·R | `ConversationPane.jsx:70,176-195`; `9a2465b` | Simulated conversation in Phase 3 |
| FX-42 | Organizers can kick before start only; never revoke hours | Done·R (owner-accepted) | `applicationRoutes.js:866-879,1024-1063` | Per shift, not per event (section C) — Ruling 12: per-shift kept |
| FX-43 | Org managers can remove members | Done·R | `OrganizationPage.jsx:200-239` | See FX-59/71/73 |
| FX-44 | Legal change → pop-up with changed lines + link; "your responsibility" clause; formatted email | Partial·R | `LegalUpdateNotice.jsx:157`; `LegalAcceptanceModal.jsx:136-237`; `notificationContent.js:62-69` | No responsibility clause — Terms §13 promises 30 days' notice instead. Wording is Owner-action (Posture B) |
| FX-45 | Clarify certificate vs transcript | Partial·V | `App.jsx:770,798`; `CertificatesPage.jsx:90-105` | Only implied; plus the third document (A7) — P1: A7 confirmed — a third document is the confusion |
| FX-46 | Certificate prints both names above the lines: Volunteer / Program Coordinator | Done·R | `CertificateDocument.jsx:115-124`; `certificatePdf.js:221-227` | |
| FX-47 | Transcript prints without a white background | Done·R | `index.css:4397` | Print preview Phase 2 |
| FX-48 | Transcript signature: Mahit Pulavarthi, Founder of WeVolunteer | Done·R | `src/config.js:72-74`; `VolunteerPortfolio.jsx:270-279` | |
| FX-49 | Org pictures: upload, or emoji on a chosen colour (iMessage-style); same for users | Done·R | `OrgAvatar.jsx`; `EmojiAvatarPicker.jsx` | ~200 curated emoji, fixed palette |
| FX-50 | Org announcements; replies; one org-level Allow Replies checkbox | Done·R | `OrganizationForm.jsx:209,460-463`; `OrganizationAnnouncements.jsx` | |
| FX-51 | Mobile regressions: dashboard scroll strips; "Message new people" size | Reported | `Messages.jsx:170-181` | Runtime only (Phase 2) |
| FX-52 | Welcome / login / signup load on mobile | Reported | `a11y/workflows/mobile.spec.js` | Runtime only |
| FX-53 | Printing prints only the document, not the page | Done·R | `index.css:4397`; `printIsolation.test.js:52-100` | Print preview Phase 2 |
| FX-54 | Org picture in search results and Discover's org tab | Done·R | `BrowseEvents.jsx:893,923` | |
| FX-55 | @mahit looks like a student profile, keeps owner badge, holds every badge/achievement/hour/streak | Partial·R | `bin/seed-qa-profile.mjs`; `ownerCompleteCollection.test.js` | Student look done. The "every badge" part exists only as a dev script writing unmarked real rows (A8). **Owner decision 1** |
| FX-56 | Mobile login: Microsoft logo overflow; less scrolling | Done·R | `providerButtonContainment.test.js`; `cf2d81b`; `b9589b2` | Scroll length judged in Phase 2 |
| FX-57 | Transcript signature (repeat) | Dup | — | → FX-48 |
| FX-58 | "Organizations" button → `/organizations` (list + create), same name everywhere | Partial·V | `BrowseEvents.jsx:661-690`; `OrganizationsHome.jsx:63,83`; `0fe739d` | Named "Your organizations". **Gate** — Ruling 5: label becomes "Organizations" |
| FX-59 | Kick dialog ("can join back", optional reason) + smaller red Ban (reason mandatory); notify; ban notice with appeal | Done·R | `RemoveMemberDialog.jsx:17-99`; `notificationContent.js:802-850` | |
| FX-60 | @mahit showcase (repeat) + account identity | Dup | — | → FX-55, FX-09 |
| FX-61 | Transcript name sits on the line; certificates unchanged | Done·R | `transcriptSignature.test.js:62-121` | |
| FX-62 | Discover date box stretched for some events | Done·R | `dateChipGeometry.test.js` | Cause was height, not width |
| FX-63 | Org-ban appeals seen by all org organizers, at the bottom | Done·R | `AppealInbox.jsx`; `OrganizationPage.jsx:776-777` | |
| FX-64 | Achievements "See all" → `/profile/badges` or `/users/@user/badges` | Partial·V | `VolunteerProfile.jsx:194`; `PublicProfile.jsx:441` | `/users/@undefined/badges` when no username (A4) — P1: A4 confirmed |
| FX-65 | Certificates capped + see all | Done·R | `VolunteerProfile.jsx:370-375` | |
| FX-66 | Same cap for shifts and certificates | Done·R | `PreviewList.jsx:60` | |
| FX-67 | Others' certificates visible, not downloadable; transcript hidden; privacy for hours and certificates; `/users/@user/hours` | Done·V | `PublicCertificates.jsx:118-135`; `certificateRoutes.js:115-117,181-183` | P1: view and PDF via `getCertificateForOwner`; `/portfolio` needs `portfolio.write` |
| FX-68 | Tag limits: 15 popular filter chips; 4 per event card | Done·R | `eventTags.js:261`; `EventCard.jsx:92` | Stale comment "three" (A14) |
| FX-69 | Appeal button beside Join when banned | Done·R | `JoinAction.jsx:97-118` | |
| FX-70 | Join → Appeal when banned; disabled once sent; 5 per 30 days; organizers can report appeal spam | Partial·V | `appealsRoutes.js:42-43,400` | No way to report appeal spam — P1: 5 per 30 days verified (`APPEAL_WINDOW_MAX`) |
| FX-71 | One settings button per member → promote/demote (label by role), kick, ban | Done·R | `OrganizationPage.jsx:200-239,1000` | |
| FX-72 | Do event tags exist? | Done·R | `server/eventTags.js` | 8 max, 30 chars |
| FX-73 | Member Manage button opened nothing | Done·R | `OrganizationPage.jsx:1000` | Click-through in Phase 2 |
| FX-74 | `mailto:` links don't work | Partial·V | `Settings.jsx:546-566` | Remain in `AboutUs.jsx:459`, `OrganizerProfile.jsx:120` (A9) — P1: A9 confirmed; the certificate share dialog's mailto is a deliberate share-by-email option and stays |
| FX-75 | Report-a-problem page with category dropdown and screenshots | Partial·R | `ReportIssue.jsx:194-206`; `issueRoutes.js:97` | No screenshot upload |

### CK — "Issues to check" (14)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| CK-01 | 2FA "Internal Server Error"; email always offered; recovery codes always a fallback; save codes as .txt or .png | Done·R (owner-accepted) | `fb934d0`; migration 055 (`f26f827`); `twoFactor.noFiveHundred.test.js`; `recoveryCodeExport.js:126,146` | Two root causes fixed. Email offered only for a *confirmed* address (section C). .txt and .png both exist — Ruling 12: email 2FA for confirmed addresses kept |
| CK-02 | No 500 for email, authenticator or recovery codes | Done·R | `twoFactor.noFiveHundred.test.js:112-300`; `routes.2faEmail.test.js:332` | Browser end-to-end in Phase 2 |
| CK-03 | "9 codes remaining" after an authenticator sign-in | Done·V | `authRoutes.js:1400-1430`; `ae4fe03` | Count was right; copy now explains it — P1: count computed only when a recovery code is spent |
| CK-04 | Removing the authenticator still showed it | Done·R | `fd47c47`; `0d18cd4`; `TwoFactorSetup.jsx:342` | |
| CK-05 | Change-email dialog can't be closed; check every dialog | Done·R | `VerifyIdentityModal.jsx:385`; `ae4fe03` | 7 overlays use `useModal` without `Modal` — each tested in Phase 2 |
| CK-06 | Adding a second factor doesn't reset recovery codes | Done·V | `twoFactorRoutes.js:244-275` | P1: codes issued only when none exist |
| CK-07 | AI mode available to everyone under `npm run dev` | Partial·V | `vite.config.js:69`; `server/authz.js:131,217,346` | Works on desktop; **iPhone/iPad get none** (A13) — Ruling 7: iPhone opt-in to Balanced |
| CK-08 | 2FA still 500s (repeat, "serious") | Dup | — | → CK-01/02 |
| CK-09 | Banned: red "Appeal" with ban text; sent → grey with clock; icons on buttons | Done·R | `JoinAction.jsx:97-118` | |
| CK-10 | Banned-member list with unban (Discord-style) | Done·R | `BannedMembers.jsx:18-148` | |
| CK-11 | Student dashboard: hours box above the stat strip | Done·R | `VolunteerDashboard.jsx:322,363,373-395`; `a5bbf6c` | |
| CK-12 | Organizer dashboard: stat strip above "Ready when you are" | Regressed·V | `OrganizerDashboard.jsx:469-545` | Card renders above; the test asserts nothing about order (A1) — P1: Misread in `a5bbf6c`: "review hours box" taken as the Awaiting-review tile; the owner pasted the close-out card as that box. Card must go below the strip, and the tile swap (not asked for — "keep everything as is") reverted |
| CK-13 | Welly's advanced model won't start | Done·R | `ai/runtime/modelCache.js`; `083b7d1`; `1295a1e` | Truncated 986 MB download reused forever |
| CK-14 | Welly creates real events by conversation, explains refusals in plain English | Done·R | `ai/eventDraft.js:358,600-650`; `ai/eventCreation.test.js` | Conversation quality needs a live run |

### EM — Email

| ID | Request | Status | Evidence | Notes |
|---|---|---|---|---|
| EM-01 | Sender profile picture on emails (also "Email stuff I have to worry about") | Owner-action·R | `docs/EMAIL_BRANDING.md:20-111` | Needs BIMI + enforcing DMARC + a paid VMC for Gmail; Gravatar on the sending address is the free route. None is code |

### P2 — The Phase 2 feature list (51)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| P2-01 | Download data and delete account | Done·R | `privacyRoutes.js:51,103,146`; `accountRoutes.js:57` | Both re-verify identity |
| P2-02 | Improved notifications | Done·R | `NOTIFICATION_KINDS`; 09-21 Pass 5 | |
| P2-03 | DMs | Done·R | `messageRoutes.js` | |
| P2-04 | Calendar integration | Partial·R | `server/ics.js:112-154` | .ics with location + alarm; no Google Calendar link; dead `downloadIcs` (A14) |
| P2-05 | "Add to Home Screen" | Partial·V | `public/site.webmanifest` | No service worker or install prompt — deliberately deferred. **Gate** — Ruling 9: install prompt, no service worker |
| P2-06 | Better mobile experience and OAuth | Partial·R | `server/config.js:515-517,666-669` | Google + Microsoft done; Apple needs a paid developer account (Owner-action) |
| P2-07 | Better 400/500 handling | Done·R | `ErrorExperience/*`; `app.errorMapping.test.js` | |
| P2-08 | Privacy Policy and ToS | Done·R | `docs/legal/policies/` (13 documents) | |
| P2-09 | Master dashboard: active users, events, hours, top tags, "we helped N people" | Partial·R | `AdminImpact.jsx:285,459-586`; `OwnerCenter.jsx:1044-1054` | No headline "we helped" figure |
| P2-10 | Personal account switches between all roles; can create and apply | Done·R | → FX-08 | |
| P2-11 | Email box: promote existing account or store for later; admin log; revoke; no new super admins | Partial·V | `invitationRoutes.js:35,116`; `adminInvitations.js`; `bin/grant-ownership.mjs` | Invitee must accept (consent + Policy 10). **No allowlist**: the CLI can make any email super_admin (A11). **Gate** — Ruling 6: keep accept-to-join; lock ownership to two addresses |
| P2-12 | Revoke: unapprove organizer, ban student, demote admin; records kept | Partial·R | `adminRoutes.js:109,1518,1609,2359` | An approved organizer cannot be unapproved |
| P2-13 | Profile pictures | Done·R | → FX-49 | |
| P2-14 | Real badges | Done·R | → FX-33/34 | |
| P2-15 | 2FA | Done·R | → CK-01…06 | |
| P2-16 | One date picker everywhere, themed | Partial·V | `DatePicker.adoption.test.jsx`; `EventEditForm.jsx:157,252,256`; `OrganizerDashboard.jsx:752`; `ShareOrganizationDialog.jsx:712,777` | Native inputs remain; calendar has no jump-to-date; N-16 declined these. **Gate** — Ruling 8: picker everywhere, typing kept |
| P2-17 | Signed-up vs attended counts, not %; on profile too | Done·R | → FX-24; `PublicProfile.jsx:379-381` | |
| P2-18 | Public `/users/:handle`; private mode hides grade/school/PII; placeholder text; public stats; show-up rate in Auto Select below hours | Done·R | `profileSerializer.js:178,192,345-364`; `ProfileEditModal.jsx:309`; `server/weighting.js` | |
| P2-19 | Organizers adjust time stayed; "left early" subtract checkbox | Done·R (owner-accepted) | `EventAttendance.jsx:356-378` | Editable actual hours instead of a checkbox. **Gate** (section C) — Ruling 12: actual-hours box kept |
| P2-20 | Events without hours | Done·R | `CreateEvent.jsx:101,309,573-575` | |
| P2-21 | "Log external hours" button like "Create event"; warning it won't reach the transcript | Partial·V | `LoggedHours.jsx`; `VolunteerDashboard.jsx:499-543` | Button only on `/hours`; the dashboard has "My logged hours". **Gate** — Ruling 3: dashboard "Log external hours" button |
| P2-22 | `/users/@username`; ⋯ menu Mute / Restrict / Report / Block; Friend + notification when a friend applies | Done·R | `PublicProfile.jsx:171-219,262`; `relationships.js:373-384`; `applicationRoutes.js:679` | |
| P2-23 | Organizations: organizers create, anyone joins, org link on events notifies members | Done·R | `server/authz.js:177,239,250`; `eventRoutes.js:1153` | |
| P2-24 | "Legal Center"; About Us with mission and motto | Done·R | `AboutUs.jsx:199,448` | |
| P2-25 | Owner legal editor: versions only go up, green Save / red Discard, from Settings | Done·R | `legal/LegalEditor.jsx:42,785,794`; `legalAdminRoutes.js:210` | |
| P2-26 | Better dashboard graphs | Reported | `ServiceInsights.jsx`; `BarChart.jsx` | Judged in Phase 2/5 |
| P2-27 | Near-me filter; location as a maps link; calendar location; weather | Done·R | `BrowseEvents.jsx:33-91`; `LocationLink.jsx:27-60`; `ics.js:17-21`; `WeatherSummary.jsx` | |
| P2-28 | QR: @username + time, 5-min expiry, only after start; organizer scan only after start; manual kept | Done·V | `checkinTokens.js:32-38`; `CheckInCodeModal.jsx:125-160`; `attendanceRoutes.js:56,869` | Organizer check-in opens 2 h before the first shift. **Gate** (A6) — A6 withdrawn: QR code exists only after the volunteer's shift starts |
| P2-29 | Hours per organization; org tags vs regular tags; an org prefix? | Done·V | `organizationHours.js`; `directoryRoutes.js:278-320` | Per-org hours done; `#` shares one namespace. **Gate** — Org hours use organization_id, never tags |
| P2-30 | On-device LLM; recommendations ("Suggested for you", keep icon); distance; near-me sort; AI tag suggestions | Done·R | `ai/models.js:98-190`; `BrowseEvents.jsx:704,982`; `TagSuggestions.jsx:62` | Qwen2.5 0.5B / 1.5B; SmolLM2-135M not used for chat |
| P2-31 | Scan a paper certificate → prefill external hours | Partial·R | `ai/certificate/extract.js:124-137` | PDF text layer only; no OCR for photos |
| P2-32 | "Enable AI mode" offer on "Suggested for you"; blurred explainer; AI policy link; 3 tiers, Recommended + green ring | Partial·V | `AIEnableModal.jsx:34-142`; policy 12 | Modal only from Settings; 2 tiers. **Gate** — Ruling 7: offer banner; 2 sizes kept |
| P2-33 | A small chatbot with user and event context; verifies certificates | Done·R | `src/ai/`; `WellyView.jsx` | Verify moved to a dashboard button |
| P2-34 | Name, logo, personality, system prompt; not a generic corner bubble; visible under `npm run dev` | Done·R | `ai/prompts/welly.js:39-141`; `App.jsx:394` | |
| P2-35 | Talks freely, proper punctuation, excellent answers | Reported | `WllamaRuntime.js:333` (`8c1342b`) | Quality is a runtime judgement (Phase 2) |
| P2-36 | Own nav entry with the Spark icon; history; responsive | Done·R | `App.jsx:394`; `68352dd` | |
| P2-37 | Mobile bar not cramped | Reported | `mobileNavFit.test.js:135-207` | Phase 2 |
| P2-38 | Clearer mode names | Done·R | `WellyModeControl.jsx` | "Welly Chat" / "Welly AI" |
| P2-39 | Button beside "Welly" → model setup | Done·V | `WellyView.jsx` | First choice of Welly AI goes to Settings. **Gate** — Mode control beside the name opens setup |
| P2-40 | On-device replies no longer split words/punctuation | Done·R | `8c1342b` | wllama final-chunk defect; non-streaming call |
| P2-41 | Same quality in chat mode | Reported | — | Phase 2 |
| P2-42 | Near-me no longer defaults to chat mode; verify as a real button; disclaimer instead of a verify link | Partial·V | `WellyView.jsx:661-711,1423,1445-1457` | Disclaimer omits "nothing leaves your device" because it would be false (search reaches the server/Pinecone). **Gate** (section C) — Ruling 14: add the precise on-device sentence |
| P2-43 | Seamless dropdown switching; first time → download screen | Done·V | `WellyModeControl.jsx:1-56` | Button panel, not a dropdown. **Gate** — Dropdown switches immediately; first pick → download |
| P2-44 | Commits not linked to the GitHub profile | Done·V | `git log` (Phase 0) | Resolved |
| P2-45 | Never ask the user to type location or personal info | Done·R | `WellyView.location.test.jsx`; `ai/personalInfo.test.js` | |
| P2-46 | `/verify` reachable, small, not in the nav | Done·R | `VerifyCertificateAction.jsx:51` | Dashboards only; not from signed-out pages |
| P2-47 | Logo: green tile, white checkmark-W, name beside it; in emails | Done·V (owner-accepted) | `BrandMark.jsx`; `server/email.js:675` | → FX-20 — Ruling 12, via FX-20 |
| P2-48 | Starting a preview lands on the dashboard | Done·R | `ModerationCenter.jsx:316`; `b166dad` | |
| P2-49 | Admin text all underlined | Done·R | `3380996` | Other admin pages checked Phase 2 |
| P2-50 | Attachments (images, PDFs, audio) in DMs and announcements | **Deferred** | — | Owner decision 3 (2026-09-30) |
| P2-51 | More Welly work | Reported | — | Folded into Phase 2/5 findings |

### LG — Legal and event-form items (13)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| LG-01 | ADA compliance: plan + implementation | Partial·R | `a11y/` suites; `docs/audits/2026-08-22-accessibility-audit.md` | Manual screen-reader pass open; certificate PDFs untagged |
| LG-02 | DMCA policy? EULA? | Partial·V | `docs/legal/13-ACCEPTABLE-USE-AND-ABUSE-REVIEW.md:25-135`; Terms :383 | DMCA procedure in Terms; agent registration is Owner-action; EULA rejected as the wrong instrument — Ruling 13: separate AUP to draft; EULA asked separately |
| LG-03 | Factor pending applications into Auto Select; cap at 10 events | Declined-by-owner | `server/config.js:435-455`; `applicationRoutes.js:623-635`; `services/autoSelect.js:160-231` | Cap done; pending not weighed. **Gate** — Ruling 10: cap kept, no Auto Select penalty |
| LG-04 | Does the legal text cover DDoS, automation, disruption? Is automation fair? AUP needed? | Partial·V | Terms §4 (`02-terms-of-service.md:159-224`) | AUP folded into Terms (section C) — Ruling 13: separate AUP |
| LG-05 | No XSS from user content; Welly prompt injection | Done·V | no `dangerouslySetInnerHTML`; `policyMarkdown.js`; `WellyMessage.jsx:90-127`; `ai/indirectInjection.test.js` | P1: zero `dangerouslySetInnerHTML`, zero `innerHTML =` in `src/` |
| LG-06 | Profile picture "under 5kb" and safe | Done·R (owner-accepted) | `profilePictureRoutes.js:118-222` | 5 MB upload; stored as ≤5 KB 192 px WebP — quality check Phase 2 — Ruling 12: 5 KB stored kept |
| LG-07 | Regroup the Legal Center | Done·R | `legal/LegalCenter.jsx:63-108` | 13 documents in 4 groups |
| LG-08 | Hours final after close-out; correctable before | Done·V | `attendance.js:477-553` | Matches 09-21 1A — P1: `finalizeAttendance` is the only writer; lock is its floor |
| LG-09 | Applications closing after the event (Sep 5 vs Aug 18) | Partial·V | `server/validation.js:33-39`; `CreateEvent.jsx:269-272` | Refused both sides, but client `>=` vs server `>` (A5) — P1: A5 confirmed |
| LG-10 | Category list too narrow, badly grouped | Done·R | `server/eventCategories.js:68-126` | 16 in 6 groups |
| LG-11 | Application-close field uses the custom picker; click opens it | Partial·V | `CreateEvent.jsx:444-462`; `DatePicker.jsx:82-90` | Still accepts typing; time is native. **Gate** — Ruling 8 |
| LG-12 | "Select / Selected" until Apply; Apply easy to find | Done·R | `EventShiftsTab.jsx:319-365` | Placement judged Phase 2 |
| LG-13 | Gap between tags and the green box | Reported | `EventHero.css:7-12` | Visual |

### SC — Scaling, Owner Center, final passes (12)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| SC-01 | Upstash for caching, sessions, rate limiting, leaderboard, chat | Done·V (owner-accepted) | `server/redis/*`; `docs/operations/upstash.md:23-60,230-245` | Rate limits + caches only; the rest measured and kept in SQL on free-tier grounds. **Gate** (section C) — Ruling 11: narrow by measurement |
| SC-02 | Caching, async jobs, fast queries, load tests, horizontal scaling | Done·R | `load-testing.md`; `horizontal-scaling.md`; `bin/multi-instance-check.mjs` | |
| SC-03 | Owner Center: Better Stack + Amplitude (controls over links), free only | Done·R | `ownerRoutes.js:96-191`; `OwnerCenter.jsx:881-1200` | |
| SC-04 | Custom certificate viewer; distinct Download and Share; share to socials and by DM | Partial·R | `CertificateView.jsx`; `CertificateShareDialog.jsx:26-147` | No "send by direct message" |
| SC-05 | Stripe donations | Deferred | — | Owner: "after launch" |
| SC-06 | Org share links like certificate share; signed-out Join prompts sign-in | Done·R | `ShareOrganizationDialog.jsx`; `SignInToJoinDialog.jsx` | |
| SC-07 | Org security: link-only join, who may invite, request-to-join; org page redesign | Done·R (owner-accepted) | `organizationPolicy.js:28-81`; `MembershipPolicyFields.jsx`; `JoinRequestInbox.jsx` | Visual redesign → revamp hand-over — Ruling 12: request-to-join mode kept |
| SC-08 | Notice system: minor legal change = banner like location's; major = blocking modal; never both; no gap | Done·R | `LegalUpdateNotice.jsx`; `AppNotices.test.jsx:88-110`; `noticeSlot.test.js:42` | Modal copy differs from the owner's wording |
| SC-09 | Upstash + Pinecone in Owner Center; re-verify every external API | Partial·R | `ownerRoutes.js:96-260` | No Google/Microsoft sign-in or Cloudflare checks |
| SC-10 | Coherence review against professional apps | Open | — | Phase 5 |
| SC-11 | Unfinished work, TODOs | Done·R | one "coming soon" (Apple) | Tech-debt register rechecked in Phase 6 |
| SC-12 | Final audit of everything; 100-user week rehearsal | Open | — | Phases 3 and 6 |

### FE — Frontend, SEO, domains (5)

| ID | Request (condensed) | Status | Evidence | Notes |
|---|---|---|---|---|
| FE-01 | Massive frontend revamp | Deferred | tokens; `docs/features/interface-motion.md`; `98b3f63` | Owner decision 4 — separate engagement |
| FE-02 | Meta description per public page; sitemap; Search Console | Missing·R | `index.html:29` | One generic description; no `robots.txt` / `sitemap.xml` |
| FE-03 | Marketing site at `wevolunteers.org`, app at `app.wevolunteers.org` | Partial·R | `deploy/nginx/wevolunteers.conf:72,82` | App subdomain live; no marketing site — revamp hand-over |
| FE-04 | Cloudflare DNS, secure | Done·R | `docs/operations/oracle-zero-cost-deployment.md` | Proxied, Full (strict), DNSSEC, origin locked to Cloudflare |
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
| 14 | P2-42 | **Add the precise version** | Disclaimer gains: "With Welly AI on, what you type stays on your device; lookups use WeVolunteer like the rest of the app." |

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
- Search Console property and sitemap submission (FE-02).
- Run the demonstration-record seed against production, if still wanted (FX-55).
- Deploys. This audit commits locally and never pushes.


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
