# WeVolunteer — Pilot Readiness Review

**Final engineering gate before launch**

**Date:** 2026-07-26
**Reviewer role:** Release manager / product owner
**Baseline:** `main` @ `8604fe3` (release tag `v1.0.0-pilot` = `7fc79cd`; the only delta is documentation)
**Target:** a supervised pilot with approximately **100–200 real users** — roughly 150 students, 10–20 organizers, 1–2 administrators, 1 deployment operator.
**Assumption per instruction:** the codebase is feature complete. Nothing below asks for a new feature. Every recommendation either fixes something broken, closes an operational gap, or removes a trap.

---

## Verdict up front

**The pilot is NOT ready to launch today. It is close.**

There are **11 P0 issues**. Nine are small — most are a few hours of work, several are one-line fixes. Two are operational (backups, a deadline watch) and one is a policy artifact, not code.

What makes this review different from the roadmap written on 2026-07-25 is that I walked the workflows end to end rather than reading a file list, and **five defects surfaced that the roadmap does not contain** — including two that break the certificate feature, which is the one thing in this product that leaves the building and reaches a college admissions office.

The backend is in genuinely good shape. Every P0 below except two lives in the client or in the deployment, and none of them threatens data integrity. Nothing here can destroy a student's credited hours. That is the right shape of problem to have a week before a pilot.

**Estimated total effort to clear all P0s: 3–4 engineering days.** Clearing P0 + P1 is roughly 2 weeks.

### Summary table

| ID | Title | Persona | Area | Effort |
|---|---|---|---|---|
| **P0-1** | Printed certificates point at a domain the district does not own | Student, external | Correctness | XS |
| **P0-2** | "Hours certificate" button opens nothing and freezes page scrolling | Student | Broken feature | XS |
| **P0-3** | Certificate verification shows "System Error" for an invalid code | External verifier | Broken feature | XS |
| **P0-4** | Rate-limit lockout reads "Request failed (429)" | All | Usability | S |
| **P0-5** | Bulk accept reports a count the server did not perform | Organizer | Correctness | S |
| **P0-6** | No error boundary — a render error blanks the whole app | All | Reliability | S |
| **P0-7** | Nobody can sign out on a phone | All | Security / usability | S |
| **P0-8** | `/events/:id/edit` is a blank form that creates a duplicate event | Organizer | Data pollution | XS |
| **P0-9** | Deadlines pass with no selection and no warning to anyone | Organizer, student | Workflow | M |
| **P0-10** | No automated, verified backups | Operator | Operational | M |
| **P0-11** | No privacy notice or consent at signup, for a product about minors | All / district | Policy | S + legal |
| **P1-1** | Auto Select re-draw uses `window.prompt`; client cap (3) contradicts server (5) | Organizer | Usability / config | S |
| **P1-2** | Check-in is buried inside the event modal | Organizer | Workflow | S |
| **P1-3** | Check-in has no tolerance for a weak network | Organizer | Reliability | M |
| **P1-4** | Incomplete ARIA tab pattern — worse than none | All | Accessibility | S |
| **P1-5** | The hours meter has no accessible value | Student | Accessibility | XS |
| **P1-6** | Touch targets are 26–35 px where 44 px is the floor | Organizer | Mobile | S |
| **P1-7** | Charts are invisible to assistive technology | Student, admin | Accessibility | S |
| **P1-8** | A transient network blip looks like being signed out | All | Reliability | S |
| **P1-9** | The leaderboard is invisible to everyone, with no explanation | Student | Usability | S |
| **P1-10** | 11 native `confirm`/`alert`/`prompt` dialogs | All | Usability | M |
| **P1-11** | Abandoned attendance drafts silently reappear later | Organizer | Correctness risk | S |
| **P1-12** | No password change and no email change for a signed-in user | All | Usability | M |
| **P1-13** | No HTTP request logging | Operator | Operational | XS |
| **P1-14** | No Content-Security-Policy on the served HTML | Operator | Security | S |
| **P1-15** | Denying an organizer deletes them with no reason and no appeal | Admin | Workflow | S |
| **P1-16** | `/health` reports a version that matches nothing | Operator | Operational | XS |
| **P2-1** … **P2-9** | See §5 | — | — | — |

**Effort key:** XS < 1 h · S = 1–4 h · M = 1–2 days · L = 3–5 days · XL > 1 week.

---

## 1. Method

I walked each persona's complete journey against the code at `8604fe3`, in the order a real person would hit it, and I ran the server to check anything I could not settle by reading.

- **Student:** sign up → verify → browse → read an event → apply to shifts → wait → learn the result → attend → receive hours → view the record → print a certificate → have someone else verify it.
- **Organizer:** sign up → hit the approval gate → get approved → build a sign-up sheet → publish → watch applications → hit the deadline → run and confirm Auto Select → run the day-of check-in on a phone → finalise hours → correct a mistake → export a roster.
- **Administrator:** approve and deny organizers → moderate events → handle a report → read platform stats.
- **Operator:** provision → configure → deploy → verify → monitor → respond to the first incident → back up and restore.

**Two findings were confirmed by running the server rather than by reading it** (§P0-3, §P0-4). Both turned out to behave worse than the code suggested at a glance.

**Scope note.** The 2026-07-25 Product Quality Roadmap remains accurate on everything it covers, and roughly half of what follows corresponds to items in it. Where my severity differs from the roadmap's, I say so and why — usually because a 100–200 user pilot changes the calculus, or because walking the workflow revealed the issue is worse than a static read implied.

---

## 2. P0 — Must fix before the pilot

### P0-1 · Printed certificates tell the verifier to visit a domain the district does not own

**Location:** [src/components/CertificateDocument.jsx](../../src/components/CertificateDocument.jsx) (named `CertificateModal.jsx` when this review was written) — `Verify at wevolunteer.org{verifyPath}`, a hardcoded string.

**1. Why it matters.** The certificate is the only artifact this system produces that leaves the platform. It goes to a school counsellor, a National Honor Society advisor, or a college admissions office. Its entire value rests on the reader being able to check it. The verification URL is hardcoded to `wevolunteer.org` and is not derived from any configuration — not `APP_URL`, not `VITE_APP_NAME`, nothing. Whatever hostname the district deploys to, every printed certificate points somewhere else.

Worth being precise about this: I wrote in the deployment runbook that the operator should check the printed URL matches their hostname. That check is right to exist, but the fix is not `APP_URL` — the string is baked into the client bundle, so no environment configuration can correct it.

**2. How a real user would encounter it.** A student finishes their first shift, opens *My profile → Certificates*, prints the certificate, and hands it to their counsellor. The counsellor types `wevolunteer.org/verify/WEV-7K2M-9QX4` and reaches a domain the district does not control — a parked page, a stranger's site, or nothing.

**3. Likely impact.** Every certificate issued during the pilot is unverifiable by its intended audience. Worse than a broken feature: the district has handed an official-looking service record to a third party with a bad link on it, which damages the programme's credibility with exactly the people it is meant to persuade. If the domain is ever registered by someone else, the district has been directing counsellors to an unknown site.

**4. Recommended solution.** Derive the origin at render time. `window.location.origin` is correct here and needs no configuration — the person printing is already on the right host. Replace the hardcoded text with the actual origin plus `verifyPath`. If you prefer an explicit value, add `VITE_PUBLIC_URL` and fall back to `window.location.origin`. While in the file, fix the stale doc comment on line 9 that still says the code is "deterministic on the server" — codes have been random since `0dcb12a`.

**5. Effort.** **XS** — one line, plus a comment. Verify by printing a certificate from the deployed host and reading the footer.

---

### ~~P0-2 · The "Hours certificate" button opens nothing, and locks page scrolling~~ — **WITHDRAWN, THIS FINDING WAS WRONG**

**Status: retracted 2026-07-26 during remediation. There was no bug.**

The original finding claimed `VolunteerDashboard.jsx:354` passed `user`/`shifts` to
`components/CertificateModal.jsx`, which destructures `certificate`/`volunteer`,
producing a silent `return null` plus a stuck `body { overflow: hidden }`.

That was a misreading. **`VolunteerDashboard` defines its own local
`CertificateModal` at line 372 of the same file**, taking exactly
`{ user, shifts, onClose }`, and never imports the shared component. The props
match, it renders via the shared `Modal` shell, and the button works. I reached
the wrong conclusion by grepping for `<CertificateModal` call sites, seeing two
with different props, and assuming both referred to the imported component
without checking for a local definition shadowing it.

Verified working in a browser against a production build: clicking **Hours
certificate** opens a printable multi-shift summary certificate.

**What was still worth changing.** The shared `components/CertificateModal.jsx`
*would* have exhibited exactly the described behaviour if ever handed a null
certificate, because `useModal` ran before the guard. That is a latent trap
rather than a live defect, and it has been hardened: the guard now returns
before any hook runs, so a component that renders nothing has no side effects.

**Lesson for the next review:** a same-name local definition beats an import.
Grep for the component's *definition* as well as its call sites.

---

### P0-12 · CORS was mounted globally and served a blank white app *(found during remediation, not in the original review)*

**Location:** [server/app.js](../../server/app.js) — `app.use(cors({...}))`, mounted on every path.

**How it surfaced.** Not by reading. I booted the production server (Express
serving `dist` + API on one port, the real pilot topology) to verify the
certificate fixes, and got a **blank black page**. `#root` was empty, no console
error. The network panel showed `GET /assets/index-*.js → 403 Forbidden`.

**1. Why it matters.** Browsers attach an `Origin` header when fetching
`<script type="module">` — **including same-origin**. The CORS middleware was
mounted globally, so it also guarded the static bundle. Any deployment whose
`CORS_ORIGINS` did not exactly match its public origin answered its own
JavaScript with 403 and rendered nothing at all.

There was a second, nastier half. Browsers also attach `Origin` to
`POST`/`PATCH`/`DELETE` even same-origin, but *not* to same-origin `GET`s. So on
a misconfigured deployment the app could load and every read would work, while
**every login and every write returned 403** with no explanation in the UI. A
partial failure like that is far harder to diagnose than a total one.

This makes `CORS_ORIGINS` the single most dangerous variable in the deployment.
My own runbook described it as "largely inert in the same-origin topology" —
**that was wrong**, and has been corrected.

**2. How a real user would encounter it.** The operator follows the runbook,
starts the service, opens the site, and sees a white page — or, worse, a working
site where nobody can sign in.

**3. Likely impact.** Total outage on first deploy, or an inexplicable
auth-only outage. Either would have consumed the launch window.

**4. Solution applied.** Two changes:
- CORS is now mounted on `/api` only. The SPA's own assets are public files and
  are served regardless — they already were to any client omitting the header.
- Same-origin API requests always pass, by comparing the `Origin`'s host to the
  request's own `Host`. This is not a weakening: a cross-site request carries
  the attacker's origin and the victim's host, so it still fails. It does
  require the proxy to pass the real Host (`proxy_set_header Host $host`), which
  the runbook already specifies.

**5. Effort.** **S** — done. Covered by 5 new tests in `app.ordering.test.js`.

---

### P0-3 · Certificate verification reports a system error for an invalid code

**Location:** [src/views/CertificateVerification.jsx:31](../../src/views/CertificateVerification.jsx#L31) — `if (err.status === 404) setStatus('invalid'); else setStatus('error');`

**Verified by running the server.** `GET /api/certificates/verify/WEV-XXXX-XXXX` returns:

```
HTTP 404 · content-type: application/json
{"valid":false,"error":"No certificate matches that code"}
```

`apiFetch` throws a plain `new Error(message)` on any non-OK response and **never attaches a `status` property**. So `err.status` is `undefined`, `undefined === 404` is false, and the page falls through to the `error` branch.

**1. Why it matters.** The `invalid` branch of this page is unreachable. It is also the best-written screen in the application — it explains that the certificate may be forged or the code mistyped, and it says so calmly. Instead, every bad code produces:

> **System Error** — We couldn't reach the verification server. Please try again later.

That is exactly backwards. A forged certificate is reported as *our* outage, and a real forgery attempt is told to try again later.

**2. How a real user would encounter it.** A school office types a code with an `O` instead of a `0` (the alphabet deliberately excludes both, so this is a likely transcription error) and is told the verification server is down. They wait and try again. Same message. They conclude the platform does not work and either accept the certificate unverified or call the school.

**3. Likely impact.** The only unauthenticated, public-facing page in the product misreports its most common failure. It makes typos indistinguishable from outages, trains verifiers to ignore the result, and — in the case that actually matters — tells someone checking a forged certificate that the *system* is broken rather than that the *certificate* is invalid. It also poisons your monitoring signal: users will report outages that are not outages.

**4. Recommended solution.** Attach the HTTP status to the thrown error in `apiFetch` (`err.status = response.status` before throwing). That is one line and fixes this call site plus any future one. Then, in this component, treat 404 as `invalid` and anything else as `error`. Add a test that a bad code renders the "Invalid Certificate" panel.

**5. Effort.** **XS** — under an hour including the test. This is the cheapest high-value fix in the review.

---

### P0-4 · A rate-limited user is told "Request failed (429)"

**Verified by running the server.** After 11 failed logins:

```
HTTP 429 · content-type: text/html; charset=utf-8
Too many requests, please try again later.
```

`express-rate-limit` returns **plain text, not JSON**. `apiFetch` calls `response.json()`, which throws, leaving `data` as `null`, so the thrown message falls back to the template string. The login screen renders, verbatim:

> Request failed (429)

**1. Why it matters.** There are four rate limiters and all of them produce this. The auth limiter is 10 attempts per 15 minutes; the mail limiter is 5. Both are set at levels a confused-but-legitimate user can reach — someone who cannot remember which of two email addresses they signed up with, or who requests several password resets because the first mail has not arrived yet.

The message tells them nothing: not what went wrong, not that it is temporary, not how long to wait. "Request failed (429)" is an HTTP status code shown to a fifteen-year-old.

**2. How a real user would encounter it.** A student returns after two weeks and cannot remember their password. They try several. On the eleventh attempt the form starts saying "Request failed (429)". They now believe the site is broken rather than that they are locked out, so they keep trying — which extends the window — and then they ask an adult for help.

There is a second, worse path. `TRUST_PROXY` mis-set behind the reverse proxy collapses every client into a single bucket, because every request appears to come from `127.0.0.1`. Ten failed logins from anyone in the district then locks out **everyone**, and everyone sees "Request failed (429)". The runbook covers configuring `TRUST_PROXY`, but the failure mode is invisible precisely because the message explains nothing.

**3. Likely impact.** The most likely support call of week one, on the screen where a bad experience costs you the user entirely. It also actively hides a serious misconfiguration.

**4. Recommended solution.** Two small changes:
- Give every limiter a JSON handler with a human message and a retry hint, e.g. `{ error: "Too many attempts. Please wait 15 minutes and try again." }`. `express-rate-limit` supports `handler` or a `message` object; the `RateLimit-Reset` header is already being sent (`standardHeaders: 'draft-7'`), so the wait can be exact.
- In `apiFetch`, add a status-aware fallback so a non-JSON error body never surfaces as a raw status code. Pairs naturally with the `err.status` change in P0-3.

**5. Effort.** **S** — 2–3 hours for all four limiters plus the client fallback and a test.

---

### P0-5 · Bulk accept tells the organizer a number the server did not perform

**Location:** [src/components/EventModal.jsx:349](../../src/components/EventModal.jsx#L349) — `addToast(\`${appIds.length} volunteer(s) ${verb}.\`)`

The server's bulk endpoint returns `{ updated, applied, skipped }` and legitimately skips applicants once a shift reaches capacity. The client ignores all three and reports the number the organizer *selected*.

**1. Why it matters.** This is the roadmap's P2-1, and I agree with its assessment that it is the most consequential non-security defect remaining. I am raising it to P0 for a 100–200 user pilot: bulk accept is exactly the tool an organizer reaches for when they have thirty applicants, and thirty applicants is precisely when capacity limits bite.

The failure is silent and confidently wrong. The organizer is not told that anything was skipped; they are told the opposite.

**2. How a real user would encounter it.** An organizer opens their applicant list for a 30-spot event with 40 applicants. They select all, click Accept, and see "40 volunteer(s) accepted." Thirty rows changed. Ten students remain pending and are never notified of anything. The organizer moves on believing the event is staffed to 40.

**3. Likely impact.** Two distinct harms. The organizer plans around a roster that does not exist and discovers the shortfall on the day. And ten students sit in `pending` indefinitely — they are not accepted, not rejected, not waitlisted, and nobody has told them anything. Combined with P0-9 (nothing chases stale pending applications) those ten students simply never hear back. For a volunteer programme, a student who applies and is ignored is a student you do not get back.

**4. Recommended solution.** Use the server's response. Report `updated`, and when `skipped` is non-empty surface it with its reason — "30 accepted · 10 skipped, shift full". If the skipped set is non-trivial, leave those applicants visibly selected so the organizer can act on them. The server already returns everything needed; this is purely a client change.

**5. Effort.** **S** — 2–3 hours including a test that asserts the toast reflects `updated`, not `appIds.length`.

---

### P0-6 · No error boundary — a single render error blanks the entire application

**Verified:** `grep -rn "componentDidCatch|ErrorBoundary|getDerivedStateFromError" src` returns nothing.

**1. Why it matters.** React unmounts the whole tree on an unhandled render error. With no boundary anywhere, any throw in any component produces a white page with no message and no recovery except a manual reload — and nothing on screen tells the user to reload.

The exposure is concentrated. `EventModal.jsx` is **1,521 lines** and handles viewing, editing, applicant review, Auto Select, check-in, and attendance finalisation. It is where nearly every organizer action happens and where nearly every future change will land. It also renders data from six different endpoints, so it has many ways to meet a shape it does not expect.

The roadmap rates this P2-3. For a supervised pilot at this size I rate it P0, for one reason: the organizer's day-of tool runs on a phone, at an event, under time pressure, with no engineer available. A white screen at that moment is not a bug report, it is a failed event.

**2. How a real user would encounter it.** An organizer at Reichler Park opens the event modal to check the roster. A slot with a null field, a stale event id after a duplicate, an application whose event was cancelled mid-session — any of these throws during render. The screen goes white. They do not know that a reload fixes it. They fall back to paper, and the hours are entered later from memory, or not at all.

**3. Likely impact.** Total, silent loss of the application for that user until they think to reload. It converts every small rendering defect into "the website is broken", which is both the worst possible support signal and the hardest to diagnose — with no request logging (P1-13) and no client error reporting, you will never learn it happened.

**4. Recommended solution.** One error boundary around the app shell with an honest panel — "Something went wrong. Reload the page." plus a reload button — and a second around `EventModal` so a failure there does not take down the navigation with it. Log the error to the console so it is visible if the user is asked to open dev tools. This is a well-understood ~40-line component.

**5. Effort.** **S** — 3–4 hours for both boundaries plus a deliberately-throwing test component.

---

### P0-7 · No user of any role can sign out on a phone

**Verified:** sign-out is rendered in exactly two places, both in `App.jsx` — the email-verification wall (line 357) and the sidebar user menu (line 436). `index.css:2121` sets `.sidebar { display: none; }` at `max-width: 700px`. The mobile bottom nav renders navigation items plus, for non-students only, a "Profile" button that opens `ProfileEditModal` — which has no sign-out either.

**1. Why it matters.** On any viewport under 700 px, there is no way to sign out. Sessions are 7-day JWTs held in `localStorage`, which survive closing the browser and closing the tab.

The device context makes this concrete rather than theoretical. A school pilot runs on shared Chromebooks, library machines, and family phones and tablets. A student who signs in on a shared device and hands it back has left an authenticated session that persists for a week and carries their name, grade, school, email, service record, and — because the profile endpoint returns `upcoming` to the student themselves — the times and locations of their confirmed future shifts.

Students are the only role with no mobile profile button at all, and students are the role most likely to be on a phone.

**2. How a real user would encounter it.** A student signs in on a friend's phone to check whether they were selected. They hand the phone back and look for a way to sign out. There is none. Rotating the phone does not help; the breakpoint is width-based. They give up, or clear the browser data if they know how.

**3. Likely impact.** A privacy exposure on shared devices, in a product whose core privacy commitment is protecting minors' data — and one the district will be asked about directly. It is also plainly confusing: every app has a sign-out, so its absence reads as a bug even to users who do not care about the security implication.

**4. Recommended solution.** Add sign-out to the mobile surface. The cheapest correct fix is to give students the same "Profile" entry the other roles have in the bottom nav, and put "Sign out" inside `ProfileEditModal` for everyone — one addition covering all three roles. A slightly better version is a small account sheet from the mobile nav with *Edit profile* and *Sign out*. Either way, do not rely on the desktop sidebar.

**5. Effort.** **S** — 2–3 hours. Verify at 375 px for all three roles.

---

### P0-8 · `/events/:id/edit` renders a blank form that creates a duplicate event

**Location:** [src/App.jsx:529](../../src/App.jsx#L529) routes `/events/:id/edit` to `<CreateEvent onSubmitEvent={handleCreateEvent} … />`.

`CreateEvent` accepts no event id, never calls `useParams()`, and initialises its form empty. `handleCreateEvent` calls `api.createEvent()`. Nothing in the application navigates to this route — real editing happens inside `EventModal` via `startEdit()`. The route is orphaned but fully reachable by URL.

**1. Why it matters.** A route that looks like "edit event" presents an empty "create event" form and, on submit, creates a second event. There is no warning, no pre-filled data, and no indication that this is not the edit screen. The organizer's intent — change this event — produces a duplicate and leaves the original untouched.

**2. How a real user would encounter it.** Less obscure than it sounds. Any of these get you there: a browser autocompleting a previously visited URL; the back button after an edit; an organizer bookmarking what they think is the edit page; someone sharing a link; or an organizer guessing the URL because the pattern is obvious from `/events/new`. A verified organizer landing there sees a plausible, empty event builder.

**3. Likely impact.** Duplicate events in a live pilot. Students see two copies of the same opportunity and apply to the wrong one; sign-ups split across both; the organizer's dashboard shows an event they did not intend to create. Cleanup is manual, and if anyone has applied to the duplicate, deleting it removes their applications. In a 10–20 event pilot, two duplicate events is a visible mess.

**4. Recommended solution.** Delete the route. Editing already lives in `EventModal` and works. If you would rather keep the URL for future deep-linking, redirect it to `/events?event=<id>` so it opens the real event with its edit affordance. Do not leave a route whose handler contradicts its path.

**5. Effort.** **XS** — deleting the route is a two-line change. The redirect version is under an hour.

---

### P0-9 · Deadlines pass, nothing happens, and nobody is told

**Verified:** `server.js` schedules only `runNotificationSweep()`, which writes deadline and shift reminders. There is no scheduled Auto Select. `POST /api/events/:id/auto-select/run` is manual-trigger only, and correctly refuses to run before the deadline.

**1. Why it matters.** Auto Select is the fairness mechanism the product is built around, and it only runs when a human clicks a button. If the organizer forgets, applications sit in `pending` forever. No notification goes to the organizer that their deadline has passed. No notification goes to the students. The event simply stalls.

The roadmap identifies this as the largest workflow hole in the product and I agree. I am putting it at P0 for a pilot of this size purely on arithmetic: with 10–20 events run by 10–20 volunteer organizers — people doing this alongside a job — at least one will forget. Probably several.

**2. How a real user would encounter it.** An organizer publishes a Saturday event with a Wednesday deadline. Wednesday passes. Nothing prompts them. On Thursday, twelve students who applied are still `pending` — they have not been accepted, waitlisted, or rejected, and their dashboard shows the application unchanged. Since selection results are in-app only (see the deployment runbook), those students have nothing to check either. On Saturday, nobody shows up.

**3. Likely impact.** The most damaging *product* failure available, because of how it feels from the student side: applying and hearing nothing is indistinguishable from being ignored. A volunteer programme runs on goodwill, and a student ignored once does not apply twice. It is also invisible to you — no error, no alert, nothing in the logs.

**4. Recommended solution.** In priority order, and the first is enough to clear P0:

- **Notify the organizer.** Extend the existing 15-minute sweep with a third rule: for any `open` event whose deadline has passed and which still has `pending` applications, write one deduplicated notification to the organizer — "Applications closed for X. 12 applicants are waiting on you." The sweep, the `dedupe_key` index, and the notification kinds all already exist; this is a new query and a `createNotification` call in the same shape as the two beside it.
- **Surface it in the UI.** The organizer dashboard already computes `needsReview`. Give past-deadline events with pending applicants a distinct, unmissable state at the top of the list.
- **Operationally, from day one.** Run the "pending past deadline" query from the deployment runbook every morning and route it to the programme owner. Do this even after the notification ships — it is the backstop for an organizer who ignores notifications.

Automatic execution of the draw is *not* recommended for the pilot. Auto Select is deliberately run-and-confirm so a human reviews the draw before it becomes real; automating it would remove a control that exists for good reason. Notify, don't decide.

**5. Effort.** **M** — 1 day for the sweep rule plus the dashboard state, with tests. The operational query is already documented and costs nothing.

---

### P0-10 · No automated, verified backups

**Verified:** nothing in the repository performs, schedules, or verifies a backup.

**1. Why it matters.** One process, one SQLite file, one disk, no replica. Credited service hours are the highest-value data here — a student's National Honor Society standing or a college application may cite them, and they cannot be reconstructed from anything else once the organizer has moved on. The deployment runbook documents the procedure in full, but a documented procedure that nobody has run is not a backup.

There is a specific trap that makes ad-hoc backups worse than useless. The database runs in WAL mode, so recent commits live in the `-wal` sidecar rather than the main file. On a freshly initialised database I measured **4 KB in `.db` against 519 KB in `.db-wal`**. Copying just the `.db` — the obvious thing to do — produces a file that opens cleanly and is missing almost everything. Nothing warns you.

**2. How a real user would encounter it.** The operator, at the worst possible moment: disk failure, a bad `rm`, or a corrupted file after an unclean host shutdown. They reach for a backup and find either none, or one taken with `cp wevolunteer.db` that restores an almost-empty database. The pilot's entire service record is gone, and there is no upstream system to re-derive it from.

**3. Likely impact.** Unrecoverable loss of every credited hour, application, and certificate. For a programme whose credibility rests on hours being trustworthy, this ends the pilot and probably the project.

**4. Recommended solution.** Implement §7 of the deployment runbook before the first real event — the procedure is written; it needs executing:

- Nightly `sqlite3 "$DB" ".backup '$OUT'"` (the online backup API, which handles WAL correctly and needs no downtime), gzipped, run as the service user from cron or a systemd timer.
- `PRAGMA integrity_check` on every backup, with a non-zero exit when it fails.
- One copy off the host.
- **Rehearse a restore before launch**, not after. This is the part that gets skipped and the part that matters.
- Alert on backup failure or on the newest backup being older than 26 hours.

**5. Effort.** **M** — 1 day including the restore rehearsal. Most of it is the rehearsal, which is exactly why it should not be cut.

---

### P0-11 · No privacy notice or consent at signup, in a product built around minors' data

**Verified:** `Signup.jsx` collects full name, email, school, grade, bio, and skills. There is no privacy policy link, no terms link, no data-handling statement, and no parental-consent path anywhere in the flow.

**1. Why it matters.** This is the one P0 that is not an engineering defect, and I am flagging it as a release manager rather than as an engineer. The platform collects identifying information about minors in a New Jersey public school district and makes some of it visible to other users — organizers see contact details for students who apply to their events; the opt-in leaderboard publishes names and hours to every signed-in user.

The engineering has been done carefully. PII scoping is enforced server-side and tested; the leaderboard is opt-in and default-off; future shift locations are visible only to the student. What is missing is the *disclosure*: nothing tells a student or parent what is collected, who can see it, how long it is kept, or how to have it removed. There is also no account deletion and no retention policy — the append-only tables are never pruned.

I am not qualified to give a legal opinion, and this review is not one. What I can say plainly is that a district counsel or privacy officer will ask these questions before a system holding student data goes live, and right now the answer is "nothing is written down".

**2. How a real user would encounter it.** A parent asks their child what the site does with their information. There is nothing to point at. Or, more likely: the district's technology or privacy officer reviews the pilot and stops it a week before launch, over a document that would have taken an afternoon.

**3. Likely impact.** A launch blocker imposed from outside, at the worst possible time — after organizers have been recruited and students have been told a date. The engineering risk is nil; the schedule risk is high, and it grows the longer nobody asks.

**4. Recommended solution.** Get in front of it now:
- Have the district's existing student-data privacy notice reviewed for this use, or write a short one covering what is collected, who sees it, retention, and the deletion request path.
- Link it from the signup form and the footer, with a checkbox acknowledging it at signup.
- Confirm with the district whether under-13 signups are in scope and, if so, what parental consent mechanism applies.
- Document a manual deletion procedure the operator can execute on request. Note that deleting a user cascades to their attendance rows and therefore destroys credited hours — decide deliberately whether deletion means anonymisation instead.
- Decide who the data owner is. That person, not the engineer, signs off the pilot.

**5. Effort.** **S** for the engineering (a link, a checkbox, a footer). The legal review is the district's timeline, not yours — **start it this week.**

---

## 3. P1 — Strongly recommended before the pilot

### P1-1 · Auto Select re-draw uses `window.prompt`, and the client cap contradicts the server

**Location:** [src/components/EventModal.jsx:250–262](../../src/components/EventModal.jsx#L250).

Two problems in one handler. The client blocks at **3** draws — `if (autoSelectRuns.length >= 3)` with the message "Maximum Auto Select reruns (3) reached" — while the server's `MAX_AUTO_SELECT_DRAWS` defaults to **5**. And the re-draw reason, which exists specifically to make the fairness audit trail meaningful, is collected with `window.prompt`.

**Why it matters.** The reason field is the accountability record for a mechanism that decides which students get to volunteer. Collecting it through an unstyled native prompt with no explanation, no validation, and no indication that it is permanently recorded gets you a field full of "x" and ".". Some mobile browsers suppress `prompt` entirely, which would make re-draws impossible on a phone with no error message. Separately, `MAX_AUTO_SELECT_DRAWS` is documented as an operator control but has no effect below 3 — the client refuses first.

**How a real user would encounter it.** An organizer re-runs a draw after a student withdraws. A bare grey system box appears asking for a reason. They type "n/a". That is now the permanent audit record of why the selection was re-run. If a parent later questions the fairness of the draw, "n/a" is what the district has.

**Likely impact.** The audit trail is technically present and practically worthless — which is worse than not having one, because it invites false confidence. Plus an operator-facing configuration that silently does nothing.

**Recommended solution.** Move the reason into a proper modal using the existing `Modal.jsx` — explain that it is recorded and shown to administrators, require a meaningful minimum length, and show the draw number. Remove the hardcoded 3 and read the limit from the server's error response (`draw_cap_reached`) so the two cannot drift again.

**Effort.** **S** — 3–4 hours.

---

### P1-2 · Check-in is buried inside the event modal

**Verified:** the only navigation to `/checkin/:eventId` is [EventModal.jsx:181](../../src/components/EventModal.jsx#L181).

**Why it matters.** Check-in is the one screen used standing up, outdoors, on a phone, while people arrive. To reach it an organizer must open the app, find the event in a list, open the modal, locate the check-in button among the modal's other actions, and tap through. Every one of those steps is happening one-handed while someone is asking where to put the cooler.

**How a real user would encounter it.** Saturday morning at the park. Volunteers are arriving. The organizer is hunting through a modal on a phone to find the roster.

**Likely impact.** Organizers fall back to paper, and paper means hours get entered late, from memory, or not at all. The check-in feature was built precisely to prevent that, and burying it wastes the work.

**Recommended solution.** Put a **Check in** button directly on the organizer dashboard's event card for any event with a shift today, and make it the primary action on those cards. Optionally deep-link it from the shift reminder notification the sweep already sends.

**Effort.** **S** — 3–4 hours.

---

### P1-3 · Check-in has no tolerance for a weak network

**Location:** [src/views/CheckInView.jsx:59–95](../../src/views/CheckInView.jsx#L59).

**Why it matters.** Every toggle is an immediate network call. On failure the optimistic update is reverted and a native `alert()` fires. There is no queue, no retry, and no offline mode. `markAll` is stricter still: if the server reports fewer marks than expected it throws and reverts **every** mark in the batch.

The deployment context is a public park, a school field, or a food pantry basement — the exact places where a phone has one bar.

**How a real user would encounter it.** The organizer ticks off eight arriving volunteers. Marks 3, 5, and 6 fail on a flaky connection. Three native alert boxes appear in sequence, each needing dismissal, and those three ticks silently revert. The organizer does not notice which ones reverted and believes everyone is checked in.

**Likely impact.** Check-in data is wrong in a way nobody notices until hours are finalised — and because check-in marks pre-populate the attendance screen, wrong marks propagate into the hours decision. This is the one place a network problem can quietly influence credited hours.

**Recommended solution.** Queue marks locally and flush them with retry; show a persistent "N unsaved" indicator rather than modal alerts; replace `alert()` with an inline banner; make `markAll` report partial success rather than reverting wholesale. Full offline support is out of scope for the pilot — a retry queue and honest status are enough.

**Effort.** **M** — 1–2 days.

---

### P1-4 · Incomplete ARIA tab pattern — worse than no ARIA at all

**Verified:** `EventModal.jsx:915–931` uses `role="tablist"`, `role="tab"`, `aria-selected`, and `role="tabpanel"`. There are **zero** `aria-controls` in the entire codebase, no `id` pairing between tabs and panels, no roving `tabindex`, and no arrow-key handler.

**Why it matters.** Declaring the tab role is a promise about how the widget behaves. A screen reader announces "tab, 1 of 5", and the user reaches for arrow keys — which do nothing. The panel is not associated with the tab, so navigating to the panel does not work as expected. Honest plain buttons would be more usable than a half-implemented tab widget.

A New Jersey public school district operates under Section 504 and ADA expectations. A student or organizer using a screen reader is not an edge case here; it is a population the district is obliged to serve.

**How a real user would encounter it.** A screen-reader user opens any event. They are told this is a tab widget. Arrow keys do nothing. They cannot tell which panel belongs to which tab.

**Likely impact.** The event modal — where applying, reviewing applicants, and finalising hours all happen — is substantially harder to use with assistive technology. This is compliance exposure, not polish.

**Recommended solution.** Either complete the pattern (`id` + `aria-controls` + `aria-labelledby` pairing, roving `tabindex`, Left/Right/Home/End handling) or drop the roles and use plain buttons. Completing it is roughly 40 lines in one file.

**Effort.** **S** — 3–4 hours.

---

### P1-5 · The hours meter has no accessible value

**Verified:** `role="progressbar"` appears **0 times**. The meter is styled divs (`.meter` / `.meter-fill`, `index.css:695`) with an inline width percentage.

**Why it matters.** Progress toward the 25-hour Silver Award is the single number this product exists to communicate. To a screen reader it is a decorative div. The surrounding text carries some of the meaning, but the visual progress indication conveys nothing.

**How a real user would encounter it.** A student using a screen reader visits their dashboard and cannot perceive how close they are to the goal without parsing the prose around it.

**Likely impact.** The product's headline metric is inaccessible to the users who most need it stated explicitly.

**Recommended solution.** Add `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, and an `aria-label` such as "12 of 25 service hours". Roughly five lines.

**Effort.** **XS**.

---

### P1-6 · Touch targets are 26–35 px where 44 px is the floor

**Verified from `index.css:490, 548, 552`,** computing rendered heights:

| Class | Padding | Font × line-height | Approx. height |
|---|---|---|---|
| `.btn` | 0.5 rem × 2 = 16 px | 0.875 rem × 1.2 ≈ 17 px | **≈ 35 px** |
| `.btn-sm` | 0.3125 rem × 2 = 10 px | 0.8125 rem × 1.2 ≈ 16 px | **≈ 28 px** |
| `.btn-icon.btn-sm` | 0.3125 rem × 2 = 10 px | 13 px icon | **≈ 23 px** |

There is no mobile override raising these; the only `min-height` in the responsive block is `56px` on `.mobilenav-item`.

**Why it matters.** WCAG 2.5.5 and both platform guidelines put the minimum at 44 px. The affected controls are not decorative — `.btn-sm` is what accept, waitlist, decline, and the check-in toggles use. These are the controls used one-handed, at an event, in a hurry.

**How a real user would encounter it.** An organizer reviewing applicants on a phone taps "Accept" on the wrong row because the rows are 28 px apart. Application status is a notified, student-visible action — a mis-tap sends a real message to a real student.

**Likely impact.** Mis-taps on consequential actions, and a general sense that the app is fiddly on a phone. Compounded by P1-10, where the confirmation is a native dialog with its own small targets.

**Recommended solution.** `min-height: 44px` on `.btn`, `.btn-sm`, and icon buttons at the touch breakpoint, with padding adjusted to keep the visual weight. Confirm no layout regressions in the applicant list and check-in rows.

**Effort.** **S** — 2–3 hours including visual verification.

---

### P1-7 · Charts are invisible to assistive technology

**Location:** `src/components/BarChart.jsx` renders raw SVG with no text alternative. Used by the volunteer dashboard (hours by month) and admin stats.

**Why it matters.** The data exists only as shapes. Screen-reader users get nothing.

**How a real user would encounter it.** A student checks their monthly hours trend; an administrator reviews participation. Both find an unlabelled graphic.

**Likely impact.** Same compliance floor as P1-4 and P1-5, lower frequency.

**Recommended solution.** Render a visually-hidden `<table>` of the same series alongside each chart, or a summary sentence ("Hours by month: March 4, April 7, May 2"). Add `role="img"` with an `aria-label` on the SVG.

**Effort.** **S** — 3–4 hours.

---

### P1-8 · A transient network blip looks like being signed out

**Location:** [src/App.jsx:150–155](../../src/App.jsx#L150) — the session-validation `catch` sets `currentUser` to `null` on **any** thrown error, not only on 401.

**Why it matters.** `apiFetch` correctly clears stored credentials only on 401. But `App.jsx` catches everything — a dropped connection, a timeout, a proxy hiccup — and renders the login screen. The token is still in `localStorage`, so a reload signs the user straight back in, but nothing tells them that.

**How a real user would encounter it.** A student on school Wi-Fi loses signal for a moment while the dashboard is loading. They are returned to the sign-in page. They assume they were logged out, and either sign in again or conclude the app is unreliable.

**Likely impact.** Erodes trust in a way that is hard to attribute — users report "it keeps logging me out" and there is nothing in any log to correlate it with. Especially likely on school networks with captive portals or aggressive filtering.

**Recommended solution.** Distinguish the cases. On a 401, sign out. On a network or 5xx error, keep the current user and show a "Couldn't reach the server — retrying" state with a retry button. The `err.status` change from P0-3 makes this straightforward.

**Effort.** **S** — 2–3 hours.

---

### P1-9 · The leaderboard is invisible to everyone, with no explanation

**Verified:** [VolunteerDashboard.jsx:327](../../src/views/VolunteerDashboard.jsx#L327) renders the section only when `leaderboard.length > 0`. Every student defaults to `leaderboard_opt_in = 0`, and the only opt-in control is a checkbox inside the profile-edit modal.

**Why it matters.** The default-off privacy decision is correct and should stay. The product follow-through is missing: the feature is dead code for every user, with no way for anyone to discover it exists. The current state is the worst of both worlds — the code is maintained, the endpoint is served, and nobody ever sees it.

**How a real user would encounter it.** They never do. That is the issue. If a student hears about it from a friend who found the checkbox, they see an empty or near-empty board.

**Likely impact.** A built feature returns nothing. Minor in isolation; it matters because it also means you will get no signal during the pilot about whether the leaderboard is a good idea for this community.

**Recommended solution.** Render the section always, with an explanatory empty state and an inline opt-in: "The community leaderboard is opt-in. Show my name and hours?" Keep the default off. That way, the pilot actually tells you whether students want it.

**Effort.** **S** — 3–4 hours.

---

### P1-10 · Eleven native `confirm` / `alert` / `prompt` dialogs

**Verified locations:** `EventComments.jsx:44`, `EventAnnouncements.jsx:69`, `EventModal.jsx:319`, `OrganizerDashboard.jsx:78`, `AdminDashboard.jsx:69` and `:83`, `VolunteerDashboard.jsx:68`, `DemoBar.jsx:34`, plus `alert()` at `CheckInView.jsx:71` and `:94`, and `window.prompt` at `EventModal.jsx:254`.

**Why it matters.** Native dialogs cannot be styled, read poorly on mobile, are inconsistent with the rest of the interface, cannot be dismissed by the app's own focus rules, and — most importantly — give no room to explain consequences. Several of these guard genuinely destructive actions: deleting an event with sign-ups, denying an organizer (which deletes their account), releasing a confirmed spot.

The project already has a good `Modal.jsx` with focus containment, Escape handling, and scroll locking, used everywhere else.

**How a real user would encounter it.** An admin denies an organizer and gets a grey system box saying the account will be removed. It cannot show what else is affected, and it looks like a browser warning rather than part of the application — which people are trained to dismiss.

**Likely impact.** Destructive actions confirmed without the user understanding the consequence, plus a visible inconsistency in an interface that is otherwise carefully made.

**Recommended solution.** A small `ConfirmDialog` built on the existing `Modal`, taking a title, a consequence description, and a labelled confirm button. Migrate all 11 sites — mechanical work. Prioritise the destructive four: event delete, organizer deny, spot release, comment/announcement delete.

**Effort.** **M** — 1–2 days for the component plus 11 call sites.

---

### P1-11 · Abandoned attendance drafts silently reappear later

**Location:** [EventModal.jsx:169–177](../../src/components/EventModal.jsx#L169) writes `wev_draft_attendance_<eventId>` to `localStorage` on every change; it is removed only on a successful submit.

**Why it matters.** Draft persistence is a good idea — an organizer half-way through marking attendance who gets interrupted should not lose their work. But the draft never expires and is never cleared on abandonment, and it is merged back in on the *next* open with those entries marked as "touched", which is what determines whether a mark is sent to the server.

Between the two sessions the world may have changed: an application withdrawn, a status corrected, a volunteer moved between shifts.

**How a real user would encounter it.** An organizer starts marking attendance, gets interrupted, and closes the modal. Two weeks later they open the attendance screen for the same event to correct one record. Their stale marks silently reappear as ticked and touched. They fix the one record they came for and save — submitting the two-week-old marks along with it.

**Likely impact.** Credited hours based on a stale draft the organizer does not remember making. The server's protections hold — a correction to an existing record still requires a reason, the ledger records every change with its actor, and no unnamed volunteer can be marked absent — so this is recoverable and auditable rather than silent. But it produces hours changes the organizer did not intend, and hours changes are the thing that must be trustworthy.

**Recommended solution.** Timestamp the draft and ignore anything older than ~24 hours. Tell the organizer when a draft is restored ("Restored 6 unsaved marks from earlier") rather than merging silently. Clear the draft when the modal closes without saving, or offer an explicit discard.

**Effort.** **S** — 3–4 hours.

---

### P1-12 · No password change and no email change for a signed-in user

**Verified:** `ProfileEditModal` edits name, avatar, bio, school, grade, skills, and the leaderboard opt-in. There is no password field, no email field, and no `PATCH` route for either. The only way to change a password is the forgot-password email flow.

**Why it matters.** A signed-in user who knows their password still has to trigger a password-reset email to change it — which requires working SMTP and a reachable inbox. If a student's password is compromised or shared with a friend, self-service remediation depends on the mail path being healthy. There is no admin override either; the runbook's recovery procedure is direct database manipulation.

Email change matters for a school specifically: students move between district and personal addresses, and graduating seniors lose their school account — along with access to the service record that took them four years to build.

**How a real user would encounter it.** A senior graduates, loses their `@student.sbschools` address, and can no longer receive a password reset. Their entire volunteer record is behind an address that no longer exists.

**Likely impact.** Low frequency during a short pilot, high severity when it happens, and it will be the first thing asked for if the pilot extends past a school year.

**Recommended solution.** For the pilot, add a "Change password" section to the profile modal — current password plus new password, bumping `token_version` as the reset flow already does. Email change needs a confirm-both-addresses flow; defer it, but document the manual procedure for the operator now.

**Effort.** **M** — 1 day for password change, front and back, with tests.

---

### P1-13 · No HTTP request logging

**Verified:** no morgan, no access log, no request middleware of any kind.

**Why it matters.** When a user reports a problem you have the handler's own `console.error` prefix and nothing else — no method, no path, no status, no client, no timing. You cannot answer "what did they actually do?" With no client error reporting either (see P0-6), a white screen leaves no trace anywhere.

**How the operator encounters it.** A student says "it broke when I tried to sign up for the food pantry thing." There is no way to find that request.

**Likely impact.** Every incident takes far longer to diagnose than it should, and some are simply undiagnosable.

**Recommended solution.** Cheapest useful fix: enable access logging at the reverse proxy — free, and gives method, path, status, and IP. Better: add `morgan` in combined format to the Express app. Be deliberate about not logging tokens or request bodies.

**Effort.** **XS** at the proxy; **S** for morgan with a sensible format.

---

### P1-14 · No Content-Security-Policy on the served HTML

**Verified:** `app.js` configures `helmet({ contentSecurityPolicy: false })`. The comment explains that the server returns JSON only and a policy belongs where the HTML is served. That was true when the comment was written — but in production **this same Express process serves `dist/index.html`** (`app.js:110–119`).

**Why it matters.** The HTML that runs the application is delivered with no CSP. The app loads no third-party resources at all, so a strict policy is achievable and cheap; the current state is an open door with nothing behind it that needs to be open.

**How the operator encounters it.** During a security review, or after an incident.

**Likely impact.** Defence-in-depth that is currently absent. Not exploitable by itself, but it is the layer that limits the damage of an XSS defect elsewhere.

**Recommended solution.** Set CSP at the reverse proxy — `default-src 'self'` as the starting point. The app uses inline styles extensively, so `style-src` will need accommodating; test in report-only mode first, then enforce. Update the comment in `app.js`, which is now misleading.

**Effort.** **S** — 2–4 hours including report-only testing.

---

### P1-15 · Denying an organizer deletes them, with no reason and no appeal

**Location:** `AdminDashboard.jsx:69` confirms via `window.confirm`; the server deletes the row.

**Why it matters.** The server-side scoping is careful and correct — denial only ever touches an unapproved organizer, specifically so a mistyped id cannot cascade-delete a student and destroy credited hours. That is good engineering. The *product* behaviour around it is blunt: the person is deleted, they are told nothing, and their only recourse is to register again and hope for a different outcome.

Organizers are community members — a librarian, a coach, a parent volunteer. Some will be denied because of a typo in their organization name, not because they should not be there.

**How a real user would encounter it.** A library director signs up, is denied because the admin did not recognise the name, and receives no notification whatsoever. They assume the platform is broken or that they were rejected without explanation. They do not sign up again.

**Likely impact.** Lost organizers during exactly the phase when you are trying to recruit them. In a 10–20 organizer pilot, losing one or two to an unexplained denial is material.

**Recommended solution.** For the pilot, the minimum is a notification to the denied account before deletion — but note that deletion removes the recipient, so the ordering matters, and a deleted user cannot read an in-app notification anyway. The honest fix is a "needs more information" state distinct from denial, plus an email. If that is too much before launch, at minimum have the admin contact the person out-of-band and document that expectation in the admin's operating instructions.

**Effort.** **S** for a documented manual process; **M** for a proper pending/rejected state with notification.

---

### P1-16 · `/health` reports a version that matches nothing

**Location:** `app.js` — `version: '2.0.0'` hardcoded, against release tag `v1.0.0-pilot`.

**Resolved in v1.0.0:** the value is now read from `server/package.json` and cannot drift.

**Why it matters.** During an incident, the first question is "what is running?" This endpoint answers it wrongly and confidently.

**How the operator encounters it.** Mid-incident, trying to establish whether a deploy went out. It actively misleads.

**Likely impact.** Wasted minutes at the worst time, and a rollback decision made on bad information.

**Recommended solution.** Read the version from `package.json`, or inject the git SHA at build time. Either is better than a literal.

**Effort.** **XS**.

---

## 4. Findings by persona

A cross-reference so each owner can see their own surface. Issues appear under every persona they affect.

### Student
P0-2 (certificate button freezes the page) · P0-3 (verification misreports) · P0-1 (wrong verify domain on their certificate) · P0-4 (lockout message) · P0-6 (white screen) · P0-7 (cannot sign out on a phone) · P0-9 (applied and never heard back) · P1-5 (hours meter) · P1-7 (charts) · P1-8 (apparent logout) · P1-9 (leaderboard) · P1-12 (password/email change)

**The student journey's weakest point is the end, not the beginning.** Sign-up, browsing, and applying are genuinely good — multi-slot selection is the best interaction in the product, and the "how hours are credited" explanation is excellent. It falls apart at the reward: the certificate button freezes the page, the printed certificate points at the wrong domain, and verification reports a system error. Three separate defects, all in the last ten metres.

### Organizer
P0-5 (bulk count) · P0-8 (duplicate-creating edit route) · P0-9 (deadline stall) · P0-6 (white screen mid-event) · P0-7 (sign-out) · P1-1 (re-draw prompt) · P1-2 (check-in buried) · P1-3 (check-in on weak network) · P1-6 (touch targets) · P1-10 (native dialogs) · P1-11 (stale drafts)

**The organizer's weakest point is the day of the event**, which is the moment the whole system either works or doesn't. Check-in is buried, the controls are 28 px, the network is bad, failures appear as native alerts, and any render error blanks the screen with no recovery. Every individual issue is small; they all land in the same five minutes.

### Administrator
P1-15 (denial is silent and final) · P1-10 (native dialogs) · P1-7 (charts) · P0-6, P0-7

The admin surface is the thinnest and, relative to its size, the healthiest. The approval queue works, moderation works, stats are informative. The main gap is that denial is a one-way door with no communication.

### Deployment operator
P0-10 (backups) · P0-11 (privacy documentation) · P0-9 (daily deadline watch) · P1-13 (request logging) · P1-14 (CSP) · P1-16 (version string)

The operator is well served by the deployment runbook, and the startup guards are genuinely good — three separate misconfigurations refuse to boot rather than failing silently. The gaps are the things no document can substitute for: backups that actually run, logs that let you diagnose, and a privacy artifact that exists.

---

## 5. P2 — After the pilot

These are real but should not hold a launch. Several are already in the roadmap.

| ID | Issue | Why it can wait | Effort |
|---|---|---|---|
| **P2-1** | `EventModal.jsx` is 1,521 lines handling six distinct modes | A maintainability risk, not a user-facing one. Refactoring under launch pressure is how bugs ship. Do it after, and after P0-6 gives it a safety net. | L |
| **P2-2** | Bundle is 476 kB unsplit (130 kB gzipped) | Acceptable at pilot scale. Notable that `/verify/:code` — loaded cold by a school office — pulls the entire app. Lazy-load that route first. | S |
| **P2-3** | `/api/applications` loads every attendance row per request | Fine at hundreds of rows. Measure during the pilot before optimising. | M |
| **P2-4** | Full refetch of all events and applications on every mutation | Correct and simple; wasteful. At 100–200 users it will be noticeable but not painful. Measure. | M |
| **P2-5** | No pagination anywhere | Not reached at pilot volume. Will matter at district scale. | M |
| **P2-6** | Organizer mobile nav crowding (6 items); 4 tables scroll horizontally | Annoying, not blocking. | M |
| **P2-7** | No account deletion; append-only tables never pruned | Needs the retention policy from P0-11 to exist first — policy before mechanism. | M |
| **P2-8** | `MAX_AUTO_SELECT_APPLICANTS` is declared in config but used nowhere | Dead config. Remove it or wire it up; do not leave an operator believing it caps something. | XS |
| **P2-9** | Deep-link and back-button polish; modals are query-param driven | Works; some flows do not restore cleanly. | M |

---

## 6. What is genuinely good

A gate review that lists only defects gives a false picture of where this project is, and it matters for deciding what to touch.

- **The hours invariant is right and holds everywhere.** Hours are never stored on the user row; every total derives from `SUM(hours_awarded) WHERE present = 1`. This single decision is why the number students care about is trustworthy in every place it appears.
- **Hours cannot be silently destroyed.** Attendance only touches records named explicitly in a request; corrections require a typed reason; every change is recorded in an append-only ledger with actor and source; an event with attendance cannot be deleted at all. This is better than most production systems I have reviewed.
- **Check-in and hours finalisation are correctly separated.** Marking someone present on the day credits nothing. Hours cannot be finalised before a shift ends. That distinction prevents an entire category of error.
- **Privacy scoping is enforced server-side and tested.** Contact details are gated to the student, admins, and organizers who host an event they applied to. Future shift locations — a minor's whereabouts at a known time — are visible only to the student. The leaderboard is opt-in and default-off.
- **The production posture is enforced by code, not documentation.** Missing `JWT_SECRET`, missing SMTP, or `DEMO_MODE` in production each refuse to boot. I verified all three.
- **Auto Select resists shopping.** Draws cannot run before the deadline, re-draws are capped and require a reason, and every draft is retained and inspectable.
- **241 tests across 24 files, all passing**, covering the paths that actually matter.
- **`useModal` is properly built** — focus containment, Escape, focus restoration, scroll lock — and used consistently. The accessibility problems are gaps, not carelessness.
- **The design system is coherent and distinctive**, and the writing throughout the interface is unusually clear.

**The pattern in the P0 list is worth naming: nine of eleven are in the client or the deployment, and none threatens data integrity.** The hard part — a correct, auditable, privacy-respecting hours system — is done. What remains is the last mile.

---

## 7. Recommended sequence

**Week 1 — clear the P0s (3–4 engineering days)**

Day 1, the cheap high-value fixes, all XS/S:
1. P0-3 — add `err.status` in `apiFetch`; fix the verification page. *(Do this first: it unblocks P0-4 and P1-8.)*
2. P0-1 — certificate verify URL from `window.location.origin`.
3. P0-2 — fix the certificate modal call site and move the guard above `useModal`.
4. P0-8 — remove or redirect `/events/:id/edit`.
5. P0-16 *(P1-16)* — fix the version string while you are in `app.js`.

Day 2:
6. P0-4 — JSON rate-limit responses with human messages.
7. P0-5 — bulk action reports the server's count.
8. P0-6 — error boundaries around the shell and `EventModal`.

Day 3:
9. P0-7 — sign-out on mobile for all three roles.
10. P0-9 — the deadline-passed sweep rule and dashboard state.

In parallel, not on the engineering critical path:
11. P0-10 — backup automation and a **rehearsed restore**. Operator.
12. P0-11 — start the privacy review **now**; it has the longest lead time and it is not yours to control.

**Week 2 — P1s, in this order**

Day-of experience first, since that is where the pilot is won or lost: P1-2 (check-in surfacing), P1-3 (network tolerance), P1-6 (touch targets), P1-1 (re-draw modal).

Then accessibility, which has a compliance floor: P1-4, P1-5, P1-7.

Then reliability and polish: P1-8, P1-11, P1-10, P1-9, P1-13, P1-14.

Defer P1-12 (password change) and P1-15 (organizer denial flow) if the schedule tightens — both have documented manual workarounds.

**Before opening to users**

- Re-run the full smoke test in the deployment runbook (§10), end to end.
- Verify a printed certificate on the real host, and have someone else verify its code from a different device.
- Confirm a backup exists, is verified, and has been restored once.
- Confirm the privacy notice is linked and the data owner has signed off.
- Confirm someone owns the daily deadline check by name.

---

## 8. Gate decision

**HOLD.** Do not launch at `8604fe3`.

**Conditions to clear the gate:**

1. All 11 P0 issues resolved and verified.
2. A backup taken, verified, and **restored once** in a rehearsal.
3. The privacy notice published and linked, with a named data owner who has signed off.
4. The full smoke test re-run end to end after the fixes.
5. A named person owning the daily "pending past deadline" check.

**Recommended, and cheap relative to their value:** P1-2, P1-3, P1-6 (the day-of experience) and P1-4, P1-5 (the accessibility floor).

With the P0 list cleared, I would launch this to 100–200 users with a named operator watching the first week. The foundations are sound, the data model is trustworthy, and the remaining work is well understood and small. **The gap between where this is and where it needs to be is measured in days, not months — but it is not zero, and every P0 above is something a real user hits in the first week.**

---

**Review ends.** Findings were derived by reading the code at `8604fe3` and by executing the server; §P0-3 and §P0-4 were confirmed against a running instance. Re-review after the P0 fixes land.
