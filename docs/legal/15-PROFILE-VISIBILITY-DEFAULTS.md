# Profile visibility defaults vs. "private by default" — owner decision

**Status: DECIDED 2026-10-04 — Option A, implemented. See §9 for what shipped and what is
still open.** Written 2026-10-04 against `main` at `d4cd8fb`; §1–§8 are the analysis as it was put
to the owner, kept unchanged so the reasoning behind the decision stays readable.

Three published documents, the About page and the signup form promise that a student's profile
is private until the student turns sharing on. The application does not work that way. Under
Posture B (no entity — see `05-LAUNCH-CHECKLIST.md` Phase 0) every published promise is
enforceable against the operator personally, and this one is live now: every new signup
acknowledges a Privacy Policy that says it.

This note records what was verified, the two ways to close the gap, what each costs under the
legal-versioning rules, and the questions only the owner can answer.

---

## 1. What is promised

Verified against production on 2026-10-04 with `GET /api/legal/documents/<slug>`. All three
returned `version: 1.0`, a `contentHash` equal to the pin in `server/legalDocuments.js`, and
`updatedAt: null` (no Legal Center revision supersedes the file). So the files below are exactly
what is being served.

| Where | Text | Consent type | Acceptances* |
|---|---|---|---|
| Privacy Policy, summary (`policies/01-privacy-policy.md:138`) | "Your profile is **private unless you change it**." | `acknowledge`, signup | 1 (a student, 2026-09-14) |
| Privacy Policy, *Who can see your information* (`:204-206`) | "Other signed-in students see only what your profile visibility setting allows. **Your profile is private by default.** You have to turn sharing on; we will never turn it on for you." | (same document) | |
| Privacy Policy, rights table (`:326`) | "Hide your profile — Settings → Privacy. It is already private unless you changed it" | (same document) | |
| Community Guidelines (`policies/03-community-guidelines.md:105`) | "**Your profile is private by default.** If you make it public, other signed-in users can see it." | `agree`, signup (bundled with the Terms) | 1 |
| Youth Safety Guidelines, *For parents and guardians* (`policies/08-youth-safety-guidelines.md:170`) | "Their profile is **private by default**. Nobody sees it unless the student changed that." | `notice` — no acceptance is ever collected | 0 |
| About page (`src/views/AboutUs.jsx:333`, `:144`) | "A student profile is private unless they change it … Private is the default, not something to go and switch on. The Privacy Policy lists every field anyone else can see, by name." | — | — |
| Signup form (`src/views/Signup.jsx:928`) | "Your profile is private unless you change it" | — | — |

\* Acceptance counts are the production figures recorded in `05-LAUNCH-CHECKLIST.md` and the
legal-repair notes on 2026-09-28. They were **not** re-queried for this note; the production
database was not touched.

## 2. What the code does

A brand-new student account, with nothing changed in Settings:

| Who can open the profile | Every holder of `directory.read`: **all students, organizers who have accepted the Organizer Agreement (adults), and administrators.** Not partners. (`server/authz.js` student/organizer/admin lists; `server/organizerAgreement.js:110`) |
|---|---|
| **Always visible, whatever the setting** | name, username, avatar, role, `location` (free text the student types), hobbies, skills, date joined, organizations — `PUBLIC_BASELINE_FIELDS` in `server/profileSerializer.js` |
| **Visible by default** — `hours_visibility = 'public'` | total credited hours, events signed up / attended / awaiting record, last-volunteered date, per-club hours, hours-by-category and milestone tiers (`GET /api/users/:id/profile`) |
| **Visible by default** — `certificates_visibility = 'public'` | the certificate collection: event title, category, organizer name, hours, first and last shift dates (`GET /api/users/:id/certificates`) |
| **Also on by default** — `friend_activity_visible = 1` | accepted friends are notified when the student signs up for an event (`server/relationships.js` `friendsToNotify`) |
| Hidden by default — `profile_visibility = 'private'` | bio, school, grade, graduation year, headline, highlights |
| Never shown to other members | email, date of birth, the itemised attendance history with locations, certificate codes |
| Off by default (matches the documents) | the leaderboard (`leaderboard_opt_in DEFAULT 0`) |

Where the defaults come from:

- `server/migrations/049_service_visibility.js` adds both columns `NOT NULL DEFAULT 'public'`, and
  says in its header that this was a deliberate product decision — and that hours were *already*
  visible to every signed-in member before it.
- `server/db/postgresSchema.js:206` carries the same defaults.
- None of the three account-creation INSERTs (`routes/authRoutes.js:556`,
  `routes/oauthRoutes.js:640`, `db.js:1732`) set the columns, so every account takes the default.
- `server/serviceVisibility.js` `normaliseVisibility` treats anything other than exactly
  `'private'` as public, on purpose (see its header).
- `server/servicePrivacy.test.js` pins it: `describe('the default is public')`.

**Timeline.** The "private by default" sentences were written on 2026-08-05 (`d79a984`). Migration
049 chose public defaults on 2026-08-14 (`a9ded8d`), and by its own account hours were already
visible to members before that. So for hours the sentence was never true. It was not a later
change that drifted away from an accurate document.

## 3. Which statements are false, and how badly

1. **Youth Safety Guidelines: "Nobody sees it unless the student changed that."** This is the worst
   one. It is false under *every* setting, because the baseline is always visible, and it is false
   by default for hours and certificates. It is also the sentence written for parents.
2. **Privacy Policy: "You have to turn sharing on; we will never turn it on for you."** False: three
   kinds of sharing are on by default (hours, certificates, friend activity).
3. **Privacy Policy: "Other signed-in students see only what your profile visibility setting
   allows."** False: the baseline ignores the setting, and hours and certificates are governed by
   two *other* settings.
4. **Privacy Policy, organizers.** *Who can see your information* says organizers see the name and
   contact details of students who applied to *their* event. That is true as far as it goes:
   contact details really are scoped. But the section reads as the complete list, and it says
   nothing about organizers being able to open every student's profile, hours and certificates.
5. **Community Guidelines: "private by default. If you make it public, other signed-in users can
   see it."** Misleading in the same way as 2 and 3.
6. **About page: "The Privacy Policy lists every field anyone else can see, by name."** False. It
   lists no profile fields by visibility.
7. **Settings → Privacy option label "Anyone at your school"** (`src/views/Settings.jsx:386`,
   `:405`). Inaccurate: the audience includes adult organizers, who need not be at the school, and
   the platform is independent of any school.

Found while verifying, related but separate: the Privacy Policy's *Your device location* says
"There is no column in WeVolunteer that holds a person's location" (`:449`). In context it is about
coordinates, but read alone it is absolute, and `users.location` exists and is always visible.
This is the same kind of defect as the guardian "Specifically:" bullet that was fixed before
launch.

## 4. The rules any fix has to respect

- A published `(slug, version)` is immutable. `LEGAL_HASHES_ENFORCED = true`, and a production
  server refuses to boot on a drifted document.
- **In-place repair** (the 054/061/069/070/071 migration pattern) works only where nobody has
  accepted the version, and the guard is enforced. Applied to this case:
  - **Youth Safety Guidelines: repairable in place.** It is a `notice` and has never collected an
    acceptance.
  - **Privacy Policy and Community Guidelines: not repairable in place.** One acceptance each.
- **A new version** goes through the Legal Center editor (version strictly greater) or through the
  file plus registry. Under the registry's own test, "private by default" becoming "visible by
  default" is **MAJOR**: it is new sharing, and a reader of 1.0 is worse off. For a signup
  document, MAJOR means:
  - a re-acceptance dialog that cannot be dismissed, for everybody who accepted 1.0;
  - participation capabilities withheld until they accept;
  - **30 days' notice** under Terms §13, unless the audited override (`LEGAL_NOTICE_PERIOD_OVERRIDDEN`)
    is used with a written reason.
- `server/legalVersioning.test.js` asserts every document is at 1.0. Its own text says it must be
  **retired, not worked around**, once real acceptances exist. A version bump retires it.
- **Three Privacy Policy corrections are already queued** (`05-LAUNCH-CHECKLIST.md` rows for
  Cloudflare, "we never prompt you to", and CARTO). They are staged above the `## Draft` marker and
  wait on "the reset", which no document defines.

## 5. Option A — change the code so the documents are true

**What it involves**

- **Migration 074** (073 is now taken; numbers cannot be reserved across branches):
  - `UPDATE users SET hours_visibility = 'private', certificates_visibility = 'private'` for
    existing accounts.
  - On PostgreSQL, `ALTER COLUMN … SET DEFAULT 'private'`. SQLite cannot change a column default
    without rebuilding `users`, the most foreign-keyed table, so all three account-creation INSERTs
    also write `'private'` explicitly. That keeps both dialects correct without the rebuild.
  - Regenerate `postgresSchema.js` (the drift test catches it if you forget).
- **Existing accounts.** Nothing records whether a student *chose* "public" or simply got the
  default: the column has a DEFAULT, there is no timestamp, and there is no audit row on the
  preference. So the migration cannot tell the two apart. Flipping everyone fails safe, and each
  student can undo it in one click. Production had 2 student accounts on 2026-09-28. The founder's
  own account would flip too, and he would turn his hours back on in Settings.
- **Optionally, narrow the baseline** so "private" means something a reasonable reader would
  recognise. Move `location`, `hobbies` and `skills` from `PUBLIC_BASELINE_FIELDS` to
  `PUBLIC_ONLY_FIELDS`. Name, username, avatar, role, organizations and distinction stay, because
  search, friend requests and organization rosters cannot work without them, and the roster
  publishes membership anyway.
- **Optionally:**
  - default `friend_activity_visible` to 0;
  - flip `normaliseVisibility` so unknown values read as private. The current direction was
    chosen *before* this promise was the governing constraint.
- **Leaderboard interaction.** The board already drops anybody whose hours are private. With
  private defaults, turning the leaderboard on would silently do nothing. The opt-in has to say it
  also shows your hours and turn them on, or explain why the student is absent.
- **Copy fixes, either option:** About ("lists every field … by name"), and the Settings label
  "Anyone at your school" → "Other members".
- **Tests:**
  - invert `servicePrivacy.test.js` "the default is public";
  - a migration test (both dialects, existing rows flipped, new rows private on every creation
    path);
  - the leakage and directory key-set assertions if the baseline moves;
  - a leaderboard opt-in case.

**What it fixes**

- The past and the future at once. Every account that was told "private" becomes private.
- No consent record is touched, no re-acceptance is needed, and there is no 30-day window. It ships
  as an ordinary deploy.

**What it costs**

- It reverses migration 049's product decision ("being able to see what somebody has actually done
  is the point of having a profile"). Most students never change defaults, so most profiles will
  show "keeps this private" where hours used to be.
- **It still leaves two document fixes:**
  - The Youth Safety sentence "Nobody sees it" stays false whatever the code does, because a
    findable profile shows a name. It needs the in-place repair, which is permitted because nobody
    has accepted it. Wording below.
  - The Privacy Policy's "see only what your setting allows" and its silence on organizer access
    are still imprecise. They become MINOR clarifications to add to the queued Privacy Policy pass.
    MINOR, because they would no longer describe more sharing than 1.0 implied.

## 6. Option B — publish documents that describe the real defaults

**What it involves**

- **Privacy Policy 2.0 (MAJOR).** Re-acceptance by the one student who accepted, capabilities
  withheld until they do, and 30 days' notice or the audited override.
- **Community Guidelines 2.0.** Same mechanism, because it shares the Terms' signup checkbox.
- **Youth Safety Guidelines.** Repaired in place at 1.0, or bumped. It collects no acceptance, so
  either way costs no consent record.
- About and Signup copy rewritten. `legalVersioning.test.js` retired.

**What it fixes**

- The product stays as designed, and the documents are honest from their effective date.
- **Bundling:** the three queued Privacy Policy corrections can ride in the same 2.0. That means
  one re-acceptance round instead of two, and it clears those launch blockers now instead of at an
  undefined reset.

**What it costs**

- **It does not cure the past.** Accounts created under 1.0 were promised privacy while their hours
  and certificates were shown to every member.
- Changing a privacy promise and applying the new terms to data collected under the old one is the
  pattern the FTC has treated as needing *affirmative express consent* (Gateway Learning, 2004, is
  the textbook case). The Privacy Policy is `consentType: 'acknowledge'`, and the registry's own
  words are "You cannot 'agree' to a privacy notice". So its re-acceptance dialog records an
  acknowledgement, not consent to the sharing. **That is a counsel question, not an engineering
  one.** In practice, B would still want existing accounts flipped to private, which is Option A's
  migration for existing rows.
- **The false text stays operative during the notice period.** That is 30 days unless the override
  is used, and every signup in that window acknowledges 1.0.
- The honest sentence is a hard one to put in front of a guardian:

  > "By default every member, including adult organizers, can see your student's hours and
  > certificates."

**Proposed wording for B**, for review, not published:

> **Privacy Policy, *Who can see your information***: **Other members**, meaning students and
> organizers who have signed the Organizer Agreement, can open your profile. They always see your
> name, username, picture, the clubs you belong to, and any skills, interests or general location
> you add. **By default they also see your volunteer hours and the certificates you have earned.**
> You can hide either in Settings → Privacy. Your school, grade, graduation year and bio are
> **hidden unless you choose to show them**. The list of individual events you attended (where you
> were and when) is never shown to other members. When you sign up for an event, your accepted
> friends are told, unless you turn that off.
>
> **Youth Safety Guidelines, parents**: Other members (students, and organizers who have signed
> the Organizer Agreement) can see your student's name, username, picture, clubs, and, unless the
> student hides them, their volunteer hours and certificates. School, grade and bio are hidden
> unless the student chooses to show them.

**Youth Safety wording under A**, needed either way:

> Other members can find your student by name and see their username, picture, and the clubs they
> belong to. Everything else on their profile (school, grade, bio, location, interests, hours and
> certificates) stays hidden until the student chooses to show it.

## 7. Recommendation

**Option A, applied to new and existing accounts, with the baseline narrowed, plus the in-place
Youth Safety repair.** It is the only path that:

- removes the exposure immediately;
- covers the people who were already told "private";
- does not depend on a consent-record decision or a counsel answer.

The Privacy Policy imprecisions then join the queued Privacy Policy pass as MINOR clarifications.

Option B is the right choice only if public hours are central to the product. Even then, existing
accounts should be flipped and counsel asked about retroactivity before 2.0 is published.

## 8. Questions for the owner

1. **A or B?** (or A for existing accounts plus B for new ones, which means two account classes
   and the most documents to keep true)
2. Under A, which extra defaults should change: narrowing the baseline, friend activity off, and
   unknown values reading as private?
3. **Youth Safety Guidelines:** repair 1.0 in place by migration (permitted, zero acceptances), or
   bump it?
4. Should the founder's account be exempted from the migration, or re-enabled by hand afterwards?

## 9. Decision and what shipped (2026-10-04)

**The owner's answers:**

| Question | Answer |
|---|---|
| A or B | **A**: make the code private |
| Extra defaults under A | **Narrow the baseline** only. Friend activity stays on by default; an unknown value still reads as public |
| Youth Safety Guidelines | **Repair 1.0 in place** |
| Founder's account | **Exempt in the migration** |

**What changed:**

- **New accounts start private.** `DEFAULT_SERVICE_VISIBILITY = 'private'`
  (`server/serviceVisibility.js`) is written explicitly by every account-creation path: password
  signup, OAuth signup, `bin/bootstrap-owners.mjs`, `bin/seed-pilot.js` and the demo seed.
  - The column DEFAULT stays `'public'`. SQLite cannot change it without rebuilding `users`.
  - `privateServiceDefaults.test.js` fails the build on any `INSERT INTO users` that does not name
    both columns.
- **Existing accounts.** Migration 074 sets both settings to `'private'` for every account except
  the founder (`FOUNDER_EMAIL`, case- and whitespace-insensitive). It was verified on SQLite and,
  by hand, on PostgreSQL.
- **Narrowed baseline.**
  - `location`, `hobbies` and `skills` moved from `PUBLIC_BASELINE_FIELDS` to
    `PUBLIC_ONLY_FIELDS`. Partner and owner accounts are exempt, the same way `headline` already
    was.
  - `profileSummary` no longer carries `location`. That closes search, rosters, join requests,
    invitations and ban lists in one place.
  - `GET /api/users/:id/profile` gates `skills` the way it already gated bio.
  - `GET /api/applications` emits `skills` only with the applicant's other particulars.
- **Youth Safety Guidelines.** Repaired in place at 1.0 by migration 075, which is allowed only
  where nobody has accepted the document. The parents' section now says:
  - who can see a student;
  - what stays hidden until the student shows it;
  - that the organizer of an event they apply to, and administrators, see more.

  The organizer bullet now scopes *contact details*, not the name. It is re-pinned, and
  `legalContent.profileVisibility.test.js` holds the words against the serializer constants.
- **Settings → Privacy.**
  - "Anyone at your school" becomes "Other members".
  - The profile hint says what is always visible and what the setting now controls.
  - The leaderboard switch explains that it shows nothing while hours are private. The board has
    always required public hours.
- **About page and signup form** were corrected separately in `9784067`. They state no default.
- The security-review gate (ENGINEERING_GUIDE §3.2) found nothing.

**Still open, and why:**

1. **Privacy Policy, MINOR clarifications.** These are queued with the three corrections the
   Privacy Policy already has waiting, and are not applied, because the document has an
   acceptance.
   - "Other signed-in students see only what your profile visibility setting allows" is still
     imprecise: name, username, picture, clubs and join date are visible whatever the setting.
   - *Who can see your information* still does not say that organizers who have signed the
     Organizer Agreement can open any student's profile.
   - "There is no column in WeVolunteer that holds a person's location" reads as absolute.
2. **"We will never turn it on for you"** is still arguable for friend activity. It notifies
   accepted friends of an event signup, and it is on by default by the owner's choice. Worth one
   sentence in the same pass.
3. **No notice was sent** to the existing students whose settings 074 changed (two student
   accounts in production on 2026-09-28). Their Settings screen shows the new state. If any of
   them had deliberately chosen "public", they will need to choose it again.
