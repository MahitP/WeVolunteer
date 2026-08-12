# Location, dashboard insight, and QR attendance — what was built

**Written 2026-08-11**, after the work, from the branch `feat/location-dashboard-qr`.
This is a record of what changed and why, for whoever picks it up next. The
decisions that were hard are written down with their reasoning; the ones that
were obvious are not.

---

## 0. The finding that reframed the whole sprint

The brief asked to "restore" maps, location and weather. Nothing had been
removed. `git log --diff-filter=D` finds no deleted location files.

Thirteen components existed in `src/components/location/`, two live server
proxies (Nominatim, Open-Meteo), and a complete haversine distance filter and
sort **implemented in SQL**. What was missing was any connection to a
student-facing surface: `LocationCard` was imported only by
`EventDetailsExperience.jsx`, which has no importer and no route — there is no
`/events/:id`. The only live map in the application was the organizer's own
location picker.

So the work was reconnection, not construction. The corollary matters for
anyone reading the brief later: **"the feature does not appear" and "the feature
was not built" look identical from the outside**, and this codebase had one of
each in the same area.

---

## 1. Prerequisites that had to come first

**`PUT /api/events/:id` wiped coordinates on every quick edit.** The UPDATE wrote
`address`/`latitude`/`longitude` unconditionally from the body; the organizer
quick-edit form sends none of them. So every quick save nulled the pin, and with
it that event's distance filtering, directions and forecast. This is *why* the
data looked absent — seeding coordinates without fixing it would have re-created
the bug on first edit. Absent now means "not editing"; explicit `null` still
clears.

**`GET /api/weather` was unauthenticated.** Rate limiter only. Gated on
`event.view` rather than `geocode.use`, because students do not hold
`geocode.use` and students are the entire audience. Cache key and upstream
params also went from 4dp (~11m) to 2dp (~1.1km): Open-Meteo's grid is 1–11km so
the forecast is identical, the hit rate rises, and the server stops keeping a
building-resolution record of which points were looked up.

**TD-19** — resolved; see the Engineering Guide entry.

**Seeds carried no coordinates**, in all three of them. Two events are left
deliberately un-pinned and one pinned-but-past, so the degradation paths are
visible in ordinary QA rather than only when a user finds them.

### One item from the plan that was dropped

The plan listed the ICS route (`GET /api/events/:eventId/slots/:slotId/ics`) as
an authorization hole because it is gated by `authenticateToken` and nothing
else. On inspection that is a **considered decision, not an oversight**, and it
is already recorded in `authz.completeness.test.js`'s `ROUTE_REGISTRY`: the file
contains title, description, location and times, and `GET /api/events` already
returns all of those to any authenticated user. The genuinely sensitive field,
`instructions`, is gated there and is not in the ICS. Adding `GEO` exposes
nothing new either, since coordinates are in the same list response.

Gating it would have broken the organizer's own "Add to Calendar" button to
protect data that is one API call away. It was left alone.

---

## 2. ETA — what is actually possible

The brief asked for ETA and "leave by", and asked not to fake it. Both halves
are load-bearing.

| Mechanism | Verdict |
|---|---|
| A browser or OS API returning travel time | Does not exist |
| Client-side call to a routing provider | Blocked: the CSP is enforcing, `connectSrc` is `'self'` plus tile hosts |
| Server-side routing proxy | Needs a new vendor, and sends a **minor's origin-destination pair** to it |
| A server-computed "leave by" push | Not deliverable on time: the sweep is a 15-minute poll |
| Distance × assumed speed | The fabrication the brief ruled out. Mode of travel varies ~5× across 9th–12th graders |

**So the ETA is handed to the calendar**, which already holds every input the
app lacks: the device's real position, the real time, and live traffic.
`buildShiftIcs` now emits `GEO`, which is what makes iOS Calendar's native "Time
to Leave" alert work. It also emits an optional `VALARM` (`?remind=<minutes>`,
defaulted to 60 by the Add-to-Calendar links).

This is not a consolation prize: it produces a *better* answer than anything the
server could compute, with no new vendor and nothing about the volunteer sent
anywhere.

**Still open for the owner:** whether to add a routing provider for an in-app
numeric ETA. That is a new subprocessor receiving a minor's origin and
destination, plus a CSP amendment. Recommendation is not to.

The 2-hour reminder was also extended — it never named the place, though the
24-hour one did, so the message arriving while somebody decides whether to set
off was the one carrying least. It now names the place and says check-in is
open, which it always was at exactly that moment.

---

## 3. Dashboard

Two charts became a section that leads with **what is waiting on somebody else**
— hours a volunteer worked that have not appeared yet. That figure already
existed (`volunteerStats.eventsAwaitingRecord`) and was already rendered on the
public profile; the screen students land on did not show it.

**The doughnut was deleted**, component and all. It answered a question that
changed nothing anyone would do next, degenerated to one or two arcs on a
five-value enum, was already rendered better on the profile as labelled bars,
and carried a latent bug — hardcoded "hours" in its `aria-label` and centre
text, with no accessible table, which is exactly what `BarChart` was fixed for.

**Zero-fill** was the other real bug: a month with no hours vanished from the
series, so the axis was a list of qualifying months rather than a timeline, and
screen-reader users could not perceive the gap at all.

### The streak, and the constraints on it

Monthly, not weekly — a weekly streak punishes exam weeks, half term, illness
and a term where the school ran nothing. It never breaks mid-month, cancelled
events cannot break it, and it is **hidden below two months**, because a "1
month streak" is one month with a flame next to it.

Nothing counts down, nothing says "keep it going", and nothing indicates what
would break it. Those are the mechanics that turn a record of what you did into
pressure about what you must do next.

`milestones.js` used to state flatly that there is no streak. That comment has
been corrected rather than contradicted — the distinction it drew still holds.

---

## 4. Reliability figures

Mostly already built: `weighting.js` computes a smoothed show-up rate for Auto
Select, `participationCountsFor` batches organizer-facing counts, and
`ApplicantReview` already rendered "N of M attended".

What was missing was the decomposition. `eventsAbsent` was computed and dropped
by the route, so "7 of 9" could mean a missed shift or unfinished paperwork, and
those are a fact about the volunteer and a fact about an organizer
respectively. Both are now published, and unconfirmed shifts are named.

**Still no rate anywhere.** Four independent places in this repository already
argue that, and they are right: "1 of 2 — 50%" reads as a verdict when the
evidence is one missed shift.

The "not enough history" threshold moved from zero to three completed
commitments. At one, the row read "0 of 1 attended".

---

## 5. QR attendance

### The token

32 random bytes, `wev1:`-prefixed, SHA-256 at rest, plaintext returned once.
**Nothing is encoded in it** — not the user, not the event, not the application
— so there is no payload to tamper with and a photograph tells a reader nothing.

**Why not an HMAC.** Single-use requires a record of what has been spent, so an
HMAC design is "a table, plus a fail-closed secret, plus a canonical signing
string, plus a constant-time comparison, plus a rotation story", and this is "a
table". Two reasons specific to this codebase make it worse than neutral: a new
signing secret is a new way for production to fail to boot, guarding a
five-minute mark that credits no hours; and there is no `timingSafeEqual`
anywhere here and no guard that would notice its absence, so a later edit
writing `a === b` reintroduces a timing side channel silently.

### Timing — the part most likely to be got wrong later

**Generation requires the slot to have started. Redemption adds no new bound at
all.**

A code cannot exist before its slot starts, so re-checking at scan time would
add a second time bound without adding a guarantee — and check-in deliberately
has an opening time and *no closing time*, because organizers reconcile after
the fact. A volunteer arriving two hours late is an ordinary Saturday. There is
a test pinning it.

This is why `slotHasStarted` is per-slot while `checkinWindowState` stays
per-event and two hours early. The instruments differ: a manual mark is an
organizer's attributed judgement and setting up early is the job, whereas a code
is a bearer credential, and one valid before the thing it attests to has begun
is one you can spend at home the night before.

### Refusals

Everything about *whether a code exists* collapses to one indistinguishable
422 — forged, spent, replaced, expired-for-another-event. Only what the
organizer could already learn from their own roster is named.

The host check runs **before** the code is looked at, so a stranger cannot burn
somebody's live code by scanning it.

Writing the test for the collapse caught a real leak: `logReason` — the internal
reason — was being serialised into the response.

### Rate limiting

A token bucket, not a fixed window, keyed on the hashed account id. The traffic
is a rush: 150 volunteers arrive in ten minutes. A window sized for that is
enormous for the rest of the day; one sized for the day stops the organizer at
the exact moment the feature exists for, and the fallback is typing 150 names.
And a campus egresses from one address, so an IP key would let one organizer's
rush stop every other organizer at the school.

### Equity

The manual roster is unchanged and presented as an equal option, not a fallback
("Scan QR code · or check people in by name below"). Every camera failure ends
in the same advice. Not every student has a phone, and an attendance system that
assumes one excludes exactly the students least able to argue about it.

---

## 6. Things worth knowing before the next change

- **`recordCheckins` is the single canonical writer.** QR is another way to name
  an application id; it validates nothing the manual path does not.
- **`attendance_checkin` still has no foreign keys.** Out of scope, unchanged,
  still debt.
- **The consume predicate (`status = 'pending'`) is currently unexercisable.**
  The scan handler and better-sqlite3 are both synchronous, so two requests
  never interleave and the resolver always catches a replay first. It is kept
  because it stops being unexercisable the moment anything in that handler
  becomes async. The test says so rather than pretending to prove it.
- **`jsqr` is a new dependency**, ~130kB, dynamically imported so nothing
  downloads it until the scanner opens, and only used when `BarcodeDetector` is
  absent — which is every iPhone.
- **Never run `npm run dev` bare.** `.env` sets `WEV_DB_PATH=../pilot.db` and
  npm runs the server workspace with cwd `server/`. There is a
  `wevolunteer-qr-qa` entry in `.claude/launch.json` pointed at a scratch file.
- **Set `WEV_REAL_DB` when running the full suite.** `dataIntegrity.test.js`
  opens `pilot.db` read-write for schema assertions; without it the WAL grows.
