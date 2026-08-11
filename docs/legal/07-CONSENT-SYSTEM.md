# The consent and legal-integration system

**Date:** 2026-08-05 · **Status:** design specification, ready for implementation
**Assumes:** [`06-REAUDIT-POSTURE-B.md`](06-REAUDIT-POSTURE-B.md) (current risk register),
[`02-DESIGN-SYSTEM.md`](02-DESIGN-SYSTEM.md) (legal-surface tokens and components),
[`01-UX-COPY.md`](01-UX-COPY.md) (voice). This document does not repeat them.

## The starting position, stated precisely

`Signup.jsx:607` renders a privacy checkbox. `Signup.jsx:154` validates it. And then
`baseFields()` (line 197) — the object actually sent to the server — **does not include it.**
The server's signup handler never reads it, and no table stores it.

The checkbox is validated and discarded in the browser. It is wrapped in `{PRIVACY_URL && ...}`,
and `PRIVACY_URL` defaults to `''`, so in a default build **it does not render at all.**

> **WeVolunteer currently holds no evidence that any user has ever agreed to anything.**

That is the gap. Not "we should add links" — there is no consent layer, in either direction:
nothing is presented reliably, and nothing is recorded ever.

---

## Phase 1 — Legal user journeys

### Design principle: consent lands at the moment of commitment

The current checkbox sits mid-form in step 1, between "skills" and the Continue button — a
place where a user is still editing, and where the act of ticking is separated from the act of
committing. Consent belongs at the **last irreversible action of the path**, which differs per
path: password signup commits at step 2, OAuth signup commits at the end of step 1
(`finishProviderSignup`). Both must be covered.

### Student

| Stage | What they see | Disclosure | Consent required | Record written |
|---|---|---|---|---|
| **Landing** | Footer legal row; "How we handle your information" link near the signup CTA | Passive notice | None | None |
| **Registration** | Consent block at the commitment step, above the submit button | ToS, Community Guidelines, Privacy, guardian block if under 18 | **ToS+CG: agree. Privacy: acknowledge. Under 18: guardian email** | `legal_acceptances` × 2–3, written **in the same transaction as the user row** |
| **Age gate** | Neutral DOB screen, before any other field | None | Not consent — eligibility | `users.date_of_birth` (or age band only — see Phase 3) |
| **Email verification** | Verify wall; legal links in the email footer | Notice | None | Existing `email_verified` |
| **First login** | One-time **Safety card** (Phase 8) | Youth Safety essentials + report route | Acknowledgement, dismissible | `legal_acceptances` (`youth-safety`, `method='dismissed_card'`) |
| **First adult conversation** | One-time inline notice above the composer | "Organizers message you about events. Report anything else." | None — notice | `user_notices_seen` |
| **Regular usage** | Settings → Legal; footer; contextual links at each control | Ambient | None | None |
| **Policy update — material** | Interstitial at next login; cannot proceed without acting | Summary of changes + diff link | **Re-acceptance** | New `legal_acceptances` row at the new version |
| **Policy update — minor** | Dismissible banner + Settings badge | Changelog entry | None | `user_notices_seen` |
| **Deletion** | Deletion consequences page | What is kept and why | Typed confirmation + step-up | `admin_audit_logs`; **acceptance rows survive** (Phase 3) |

### Organizer

Everything above, plus a **second, separate gate**:

| Stage | What they see | Consent | Record |
|---|---|---|---|
| **Registration** | Same student consent block | Same | Same |
| **Awaiting approval** | "Your organizer account is under review" + the Organizer Agreement to read now | None yet | — |
| **Approval** | **Organizer Agreement, full text, with 7 attestation checkboxes** | **Explicit, itemised** | `legal_acceptances` (`organizer-agreement`) + gates `organizer.approve` |
| **Before first event** | Safety reminder on the create-event form | Notice | — |
| **Agreement update** | **Organizer capabilities pause** until re-accepted; the rest of the account works | **Re-acceptance** | New row |
| **Suspension** | Reason, effective date, appeal route | — | Acceptance history retained as evidence |

### Administrator

| Stage | What they see | Consent | Record |
|---|---|---|---|
| **Grant** | Admin Responsibilities Policy, 5 attestations, before the capability is issued | **Explicit, itemised** | `legal_acceptances` (`admin-policy`) |
| **Mandated-reporter briefing** | DCP&P procedure, acknowledged separately | **Explicit** | `legal_acceptances` (`mandated-reporter`) |
| **Quarterly** | Access-review prompt | Re-attestation | New row |
| **Reading a reported conversation** | Interstitial: "This access is logged against your name" | None — notice | `admin_audit_logs` |

Admin acceptance is **not optional and not deferrable**: the capability grant is what the
acceptance unlocks, so an unaccepted admin is simply an admin who does not have the capability
yet.

---

## Phase 2 — Signup flow

### Which documents need what

| Document | Treatment | Reasoning |
|---|---|---|
| **Terms of Service** | **Explicit agreement** | It is a contract. It needs an affirmative, unambiguous act |
| **Community Guidelines** | **Explicit agreement, same checkbox as ToS** | Legally incorporated by reference into the ToS — a second checkbox for one contract adds friction without legal benefit. But it is *named* on the line, because the behavioural commitment matters and an unnamed rulebook is unenforceable in practice |
| **Privacy Policy** | **Acknowledgement, separate checkbox** | You cannot "agree" to a privacy policy — it is a disclosure, not a bargain, and asking a fourteen-year-old to *agree* implies they could disagree and still sign up. Separate because bundling notice with contract weakens both |
| **Youth Safety Guidelines** | **Notice at signup; acknowledgement at first login** | Loading it into signup buries it. It lands better as a first-login card (Phase 8) |
| **Cookie Notice** | Notice only | No non-essential storage, so there is nothing to consent to |
| **Certificate / Volunteer Record policies** | Notice, contextual | Reference documents. Linked where they matter — the deletion flow, the verify page |
| **Organizer Agreement** | Explicit, itemised, separate flow | Phase 7 |
| **Admin Policy** | Explicit, itemised, separate flow | Phase 1 |

**Two checkboxes, not three, not one.** One bundled box is a weaker record because it conflates
agreement with acknowledgement. Three or more produce clickthrough, and a fourteen-year-old
ticking four boxes in two seconds is worse evidence than one they read.

### Desktop layout — at the commitment step

```
┌──────────────────────────────────────────────────────────┐
│  Before you finish                                       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ We store your name, email, and grade so organizers │  │
│  │ know who's volunteering. Your profile is private   │  │
│  │ unless you change it. You can download or delete   │  │
│  │ everything later.                                  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ☐  I agree to the Terms of Service and to follow the    │
│     Community Guidelines.                                │
│     Read the Terms · Read the Guidelines                 │
│                                                          │
│  ☐  I've read how WeVolunteer handles my information.    │
│     Read the Privacy Policy                              │
│                                                          │
│  ── Because you're under 18 ─────────────────────────    │
│  ☐  A parent or guardian has gone through this with me.  │
│                                                          │
│     Their email address                                  │
│     ┌──────────────────────────────────────┐             │
│     │                                      │             │
│     └──────────────────────────────────────┘             │
│     We'll send them a note confirming your account,      │
│     and we'll tell them if there's ever a safety         │
│     problem. We won't email them about anything else.    │
│                                                          │
│  [ Create my account ]                                   │
└──────────────────────────────────────────────────────────┘
```

### The wording, and why each word

| Element | Copy | Reasoning |
|---|---|---|
| Heading | **Before you finish** | Not "Legal" or "Terms". Signals a step, not a wall |
| Summary card | The three facts | Given, not linked. Most users will not open a document; the load-bearing facts must survive that |
| Box 1 | **I agree to the Terms of Service and to follow the Community Guidelines.** | "Agree" is correct for a contract. "*Follow*" the Guidelines, not "agree to" — you follow rules, and the verb primes behaviour |
| Box 2 | **I've read how WeVolunteer handles my information.** | Not "agree to the Privacy Policy". Contraction and plain phrasing are deliberate at this reading level. The document name appears on the link beneath, so the record still names it |
| Guardian | **A parent or guardian has gone through this with me.** | "Gone through this with me" describes a real event a student can honestly attest to. "I have permission" is a claim about someone not present |
| Guardian rationale | "We'll tell them if there's ever a safety problem. We won't email them about anything else." | Answers the two questions a teenager actually has: what will you tell them, and will you spam them |
| Button | **Create my account** | Names the outcome |

**Links open in a new tab (`target="_blank" rel="noopener"`), never navigate away.** A signup
form that loses state because someone opened the Terms is a form that teaches people not to
open the Terms.

### Validation errors

Inline, beneath the offending control, `role="alert"`, and never a generic form-level error.

| Condition | Message |
|---|---|
| Box 1 unticked | **You'll need to agree to the Terms to create an account.** You can read them first — the link opens in a new tab. |
| Box 2 unticked | **Please confirm you've seen how we handle your information.** |
| Guardian box unticked | **We need a parent or guardian to have seen this with you.** |
| Guardian email empty | **We need an email address for your parent or guardian.** |
| Guardian email malformed | **That doesn't look like an email address — could you check it?** |
| Guardian email = student's | **This needs to be a different address from your own.** |
| Submit with several missing | Focus moves to the **first** unmet control; each shows its own message |

No error says "invalid" or "required field". Each says what to do next.

### Mobile (<700px)

- Consent block is the **last thing before the button**, full-width, `--s4` gutters.
- Checkbox targets **44×44px minimum** with the label as part of the target.
- Summary card collapses to 3 bullets.
- Document links become full-width tappable rows with a chevron, not inline text links —
  inline links inside a paragraph are the hardest thing to hit accurately on a phone.
- The guardian section is a visually distinct panel (`--legal-important-*`) so it is not
  mistaken for optional extras.
- **Never** put the consent block behind a scroll-to-continue or an accordion.

### The OAuth path

OAuth signup commits at the end of step 1 (`finishProviderSignup`), not step 2. The consent
block must render there too, and `submit()` must carry the payload on both paths. A user who
signs up with Google and is never asked is the exact hole that makes the whole record
worthless.

---

## Phase 3 — Consent recording

### Schema

Two migrations, `006` and `007`, following the versioned registry (`server/migrations/`) — this
is structural and belongs there, not in `addColumnIfMissing`.

```sql
-- 006_legal_documents.js
CREATE TABLE legal_documents (
  slug            TEXT NOT NULL,          -- 'terms-of-service', 'privacy-policy', …
  version         TEXT NOT NULL,          -- '1.0', '1.1', '2.0'
  content_hash    TEXT NOT NULL,          -- sha256 of the published text
  effective_at    TEXT NOT NULL,          -- may be future-dated (notice period)
  published_at    TEXT NOT NULL,
  consent_type    TEXT NOT NULL CHECK(consent_type IN ('agree','acknowledge','notice')),
  requires_reconsent INTEGER NOT NULL DEFAULT 0,  -- material change?
  supersedes      TEXT,                   -- previous version
  change_summary  TEXT,                   -- plain-language, shown in the interstitial
  PRIMARY KEY (slug, version)
);
CREATE INDEX idx_legal_documents_effective ON legal_documents(slug, effective_at DESC);

-- 007_legal_acceptances.js
CREATE TABLE legal_acceptances (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  document_slug TEXT NOT NULL,
  version       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,   -- denormalised on purpose; see below
  accepted_at   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK(method IN
                  ('signup','reconsent','organizer_approval','admin_grant',
                   'first_login_card','guardian_link','settings')),
  context       TEXT,            -- 'password' | 'oauth:google' | 'admin:<id>'
  ip_prefix     TEXT,            -- TRUNCATED. /24 v4, /48 v6. Never the full address
  ua_family     TEXT,            -- 'Chrome 120 / Android'. Never the raw string
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_acceptances_user ON legal_acceptances(user_id, document_slug, accepted_at DESC);
CREATE INDEX idx_acceptances_doc  ON legal_acceptances(document_slug, version);
```

Plus a guardian table, since guardian consent is a distinct legal act with its own lifecycle:

```sql
CREATE TABLE guardian_consents (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  guardian_email TEXT NOT NULL,
  token_hash     TEXT,            -- hashed, like every other token in this codebase
  confirmed_at   TEXT,            -- NULL until the guardian clicks through
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,            -- a guardian may withdraw
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_guardian_active ON guardian_consents(user_id) WHERE revoked_at IS NULL;
```

### Design decisions worth defending

**`content_hash` is denormalised into the acceptance row on purpose.** The question that gets
litigated is never "did they click" — it is **"what exactly did they agree to?"** Joining to
`legal_documents` answers that only while that table is intact and honest. Storing the hash on
the acceptance itself means the record is self-proving even if the documents table is later
edited, and any tampering becomes detectable rather than invisible.

**`ON DELETE RESTRICT`, not `CASCADE`.** Acceptance records must survive account deletion. This
matches the existing anonymise-don't-delete model: the row keeps the user id, and the id no
longer resolves to a person. Cascading would destroy the evidence that the person agreed —
which is precisely the evidence you would need if they later claimed they had not.

**`guardian_consents` cascades where `legal_acceptances` restricts, and the asymmetry is
deliberate.** An acceptance row is evidence about *the user* and must outlive them on the
platform. A guardian consent row contains **a third party's email address** — a parent who never
signed up and has no account. When the student's account goes, the parent's contact details have
no remaining purpose, so they should go with it. Keeping a permanent record of a
non-user's email to prove a child's account existed is the kind of retention that is hard to
justify and easy to avoid.

Note also that today's deletion is *anonymisation* (an `UPDATE`, not a `DELETE`), so `RESTRICT`
never actually fires. It is there as a guard against a future hard-delete path removing the
evidence by accident.

**IP truncated, never stored whole.** A /24 (v4) or /48 (v6) prefix retains everything the
record needs — "this came from a plausible network at this time" — while not being a per-child
location trail. Storing full IPs of minors, indefinitely, to prove a checkbox, is the kind of
collection that reads badly in exactly the proceeding where you would be producing it.

**User-agent family, never the raw string.** The raw UA is a fingerprinting surface. "Chrome 120
/ Android" carries the evidentiary value ("a real browser, consistent with their other
sessions") with a fraction of the identifiability.

### What must not be stored

Precise geolocation · full IP addresses · raw user-agent strings · device or advertising IDs ·
session tokens or JWTs · the document body in the acceptance row (hash + reference instead) ·
the guardian's name, address, or anything beyond the email · behavioural telemetry about how
long someone spent on the page.

That last one is tempting — "they had the page open for 8 seconds" feels like evidence. It is
not: it proves nothing about reading and it converts a consent record into a surveillance
record.

### Retention

| Record | Retention | Why |
|---|---|---|
| `legal_acceptances` | **Life of the account + 6 years** | New Jersey's limitation period for contract actions is 6 years. Shorter than that and you cannot defend a claim within its own window |
| `legal_documents` | **Permanent** | A version must remain retrievable forever, or older acceptance rows reference nothing |
| `guardian_consents` | Life of the account + 6 years; `token_hash` cleared on confirmation | The token is a live credential — it should not outlive its use |

This is a deliberate exception to the 1-year audit-log retention. Consent records are not audit
logs: audit logs detect misuse and go stale, consent records prove an agreement and must
outlive the relationship. **Say so explicitly in the Privacy Policy retention table**, because
an unexplained long retention is worse than a long one with a reason.

### Privacy implications, disclosed

Add to the Privacy Policy retention table:

> **Records of what you agreed to** — kept while you have an account and for 6 years after.
> This is a short record: which document, which version, and when. We keep a rough network
> location (not your full address) and your browser type. We keep it because if there is ever a
> disagreement about what you signed up to, this is how it gets settled — for you as much as
> for us.

---

## Phase 4 — Versioning

### Scheme: `MAJOR.MINOR`, where MAJOR is defined by consequence, not by size

| Change | Bump | Action |
|---|---|---|
| New data collected, new sharing, new obligation, reduced right, changed retention, new fee | **MAJOR** | **Re-consent required.** 30 days' notice, effective date in the future |
| Clarified wording, corrected typo, restructured, added example, updated contact | **MINOR** | Notice only. Changelog entry, dismissible banner |
| Legally-compelled immediate change | **MAJOR**, effective immediately | Re-consent at next login, with the reason stated |

**The test is not "how many words changed."** It is: *would a reasonable user who read the old
version be surprised, or worse off?* If yes, MAJOR. A one-word change from "we do not sell your
data" to "we may sell your data" is MAJOR. Rewriting an entire section for clarity without
changing what it means is MINOR.

Record the decision and its reasoning in `change_summary`. A regulator asking "why was this
treated as a clarification?" should find the answer written before the question was asked.

### Publication workflow

```
1. DRAFT        Edit in docs/legal/policies/. Version stays unbumped.
2. CLASSIFY     MAJOR or MINOR, with written reasoning.
3. REVIEW       MAJOR touching data handling or safety → counsel.
4. STAGE        Insert legal_documents row: version, content_hash, effective_at
                (today+30 for MAJOR), consent_type, change_summary, supersedes.
                Publish the document at its versioned URL immediately.
5. ANNOUNCE     MAJOR: in-app banner + email at T-30, T-7, T-0.
                MINOR: banner + changelog; no email.
6. EFFECTIVE    At effective_at, requiresReconsent() begins returning true.
7. ENFORCE      Interstitial at next authenticated request. Grace window below.
8. ARCHIVE      Old version stays permanently retrievable at its versioned URL.
```

**Nothing is ever edited in place after publication.** A published version is immutable; a
correction is a new MINOR version. The content hash is what makes this enforceable rather than
aspirational — a boot-time check can verify that every `legal_documents` row still matches the
file it claims to hash, exactly as the migration registry already re-verifies its own checksums
on every boot. **Reuse that pattern; it is already proven in this codebase.**

### The grace window — a real decision

A hard block at the interstitial means a student who declines is locked out of their own service
record. That is disproportionate and, for a record they may need for graduation, arguably
punitive.

**Recommended:** on a MAJOR change, the interstitial offers three actions —

- **Accept** → proceed normally
- **Review first** → read the diff, return to the interstitial
- **Not now** → **14-day grace period.** The account remains fully usable. The banner persists.
  After 14 days the account enters **read-only**: sign in, view and export the record, delete
  the account — but no applying, messaging, or posting.

Read-only rather than locked-out is the key. The user keeps access to their own data forever,
which is the thing they have a right to; they lose the ability to enter *new* transactions under
terms they have not accepted, which is the thing you have a right to withhold.

Declining is never a dead end: "Delete my account and download my data" is always on the
interstitial.

### Announcement copy — MAJOR

> **We're updating our Terms — here's what's changing**
>
> From **5 September 2026**, our Terms of Service change. The short version:
>
> - Organizers can now only message you about events you've applied to
> - We've added how to appeal if we suspend your account
>
> Nothing about what we collect is changing.
>
> [ See exactly what changed ] [ Read the new Terms ]

Lead with what changes *for them*. The "nothing about what we collect is changing" line
pre-empts the question every privacy-conscious reader has, and when it is *not* true, its
absence is itself informative.

---

## Phase 5 — Policy accessibility

### Recommended information architecture

```
/legal                          Legal Center — the hub
├── /legal/terms                Terms of Service
├── /legal/privacy → /privacy   (existing route; canonical, keep it)
├── /legal/guidelines           Community Guidelines
├── /legal/safety               Youth Safety
├── /legal/deletion             What happens when you delete
├── /legal/certificates         How certificates are checked
├── /legal/records              How hours work
├── /legal/cookies              Cookies & tracking
├── /legal/organizers           Organizer Agreement
├── /legal/admins               Admin Responsibilities
├── /legal/changes              Changelog — every version, every change
└── /legal/v/:slug/:version     Permanent archive of any version

/settings/legal                 "Your agreements" — personal, authenticated
```

### Placement, evaluated

| Location | Verdict | Detail |
|---|---|---|
| **Landing footer** | **Required** | Privacy · Terms · Safety · Legal Center. Present signed-out |
| **Signup** | **Required** | Inline at the consent block, new tab |
| **Login** | **Recommended, minimal** | Footer row only. A login screen is not a reading surface |
| **Settings** | **Required** | Both the documents *and* "Your agreements" |
| **Help Center** | **Cross-link only** | Help answers "how do I", legal answers "what are the rules". Distinct jobs; link, do not merge |
| **Dedicated Legal Center** | **Required — the spine** | Everything else points here |
| **In-context** | **Required, highest value** | At the leaderboard toggle, the delete button, the export card, the verify page, the application form. **This is where documents actually get read** |
| **Email footers** | **Required** | Every transactional email: Privacy · Terms · Unsubscribe |
| **Error pages** | Recommended | The 404/500 experience already exists; add the footer row |

**"Your agreements" in Settings is the piece most platforms omit**, and it is the highest-trust
element in this entire system:

```
Your agreements
─────────────────────────────────────────────
Terms of Service            v1.1   3 Sep 2026   [View this version]
Community Guidelines        v1.1   3 Sep 2026   [View this version]
Privacy Policy              v1.2   3 Sep 2026   [View this version]   Acknowledged
Youth Safety                v1.0   2 Sep 2026   [View this version]   Seen
─────────────────────────────────────────────
A parent or guardian confirmed your account on 2 Sep 2026.
[ Download these records ]
```

It converts the consent database from something done *to* the user into something they can
inspect. It is also, not incidentally, the fastest way to answer a subject-access request.

---

## Phase 6 — Legal Center

Components, tokens, callouts, layout, and the six page designs are specified in
[`02-DESIGN-SYSTEM.md`](02-DESIGN-SYSTEM.md) and not repeated. **New here:** search, changelog,
version archive, and the personal agreements view.

### Hub — with the new elements

```
┌────────────────────────────────────────────────────────────┐
│  🛡  Legal & Safety                                        │
│  Everything about how WeVolunteer works, who can see what, │
│  and what to do when something's wrong.                    │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 🔎  Search — "delete my account", "who sees my hours"│  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  Start here                                                │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ │
│  │ 🛡 Privacy     │ │ 👥 Staying safe│ │ 📄 Terms       │ │
│  │ What we collect│ │ Rules + how to │ │ The rules of   │ │
│  │ and who sees it│ │ report a problem│ │ using this     │ │
│  │ v1.2 · 6 min → │ │ v1.0 · 4 min → │ │ v1.1 · 8 min → │ │
│  └────────────────┘ └────────────────┘ └────────────────┘ │
│                                                            │
│  Your choices                                              │
│  ⬇ Get a copy of my data   🗑 Delete my account            │
│  👁 Who can see my profile  📋 What I've agreed to          │
│                                                            │
│  The details                                               │
│  Community Guidelines · Cookies · Certificates ·           │
│  How hours work · For organizers · For admins              │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📅 Recently changed                                  │  │
│  │ Terms of Service v1.1 — 3 Sep 2026                   │  │
│  │ Organizers can only message applicants  [What changed]│ │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ✉ wevolunteer.platform@gmail.com — reply within 10 days   │
│  🚨 Emergency: 911 · NJ child abuse: 1-877-NJ-ABUSE        │
└────────────────────────────────────────────────────────────┘
```

### Search

**Client-side, over a build-time index. No server, no query logging.**

A legal-page search box that phones home creates a log of which students searched "delete my
account" or "someone is harassing me" — a record with real potential to harm the person who
made it. A prebuilt JSON index (headings + first sentence per section, ~40 KB) searched in the
browser has no such log.

- Fuzzy match over heading and body
- Results grouped by document, showing the section heading and matched sentence
- Deep-links to the anchor
- Empty state: **"Nothing matched that. Try 'delete', 'hours', 'messages', or 'certificates' —
  or just email us and we'll answer."** — always ending in a human
- Keyboard: `/` focuses, `↑↓` navigate, `Enter` opens, `Esc` clears
- `role="combobox"` + `aria-expanded` + `aria-activedescendant`; results in an
  `aria-live="polite"` region announcing the count

### Changelog — `/legal/changes`

Reverse-chronological, one entry per version:

```
┌────────────────────────────────────────────────────┐
│ Terms of Service  v1.1        3 September 2026     │
│ ● Material change — we asked everyone to re-accept │
│                                                    │
│ What changed                                       │
│ • Organizers can only message students who applied │
│ • Added how to appeal a suspension                 │
│                                                    │
│ [Read v1.1]  [Compare with v1.0]  [Read v1.0]      │
└────────────────────────────────────────────────────┘
```

The badge distinguishing material from clarifying changes is the honest core: it tells a reader
which updates were significant enough to require their agreement, without them having to
reverse-engineer it from diffs.

### Version archive — `/legal/v/:slug/:version`

Permanent, immutable, indexable. Header callout:

> ℹ️ **This is version 1.0, which applied from 2 Sep 2026 to 3 Sep 2026.** It is kept so you can
> see what you agreed to at the time. [Read the current version]

Linked directly from every row of "Your agreements", so a user can always read *exactly* the
text they accepted — not the current text.

### Mobile

Search collapses to a full-width tap target opening a full-screen sheet. Cards stack single
column. The contact and emergency block is **sticky at the bottom** of the hub only — the one
place a persistent affordance is justified, because a user on the Legal Center on a phone is
disproportionately likely to be looking for help rather than reading.

### Accessibility

Beyond the [existing report](03-ACCESSIBILITY-REPORT.md): search is a full combobox pattern;
results announce their count politely; the changelog is a `<ul>` of `<article>`s with real
heading structure, not a table; version badges carry text, never colour alone; the archive
callout is the first thing in the DOM after the `h1` so a screen-reader user learns they are on
an old version before reading it.

---

## Phase 7 — Organizer requirements

### Separate acceptance — yes, decisively

Organizer acceptance must be **its own gate, at its own moment**, for three reasons:

1. **Different consideration.** A student agrees to use a service. An organizer agrees to
   receive minors' contact details and to accept duties about them. Bundling them at signup
   means the person who becomes an organizer three weeks later never agreed to the second thing.
2. **Different timing.** Organizer status is granted at approval, not registration. Consent must
   attach to the grant.
3. **Different failure mode.** An organizer who has not re-accepted an updated agreement should
   lose **organizer capabilities**, not their account. Bundled consent cannot express that.

### What organizers attest to

The seven attestations already drafted in
[`policies/09-organizer-agreement.md`](policies/09-organizer-agreement.md) §13 — read the
agreement; understand most students are minors; use contact details only for your own events and
delete copies within 30 days; never alone with a single student and two adults present; NJ
mandated-reporter duty is personal and runs to DCP&P; record hours accurately; understand
WeVolunteer has run no background check.

Each is a **separate checkbox**, and here the friction is the point — this is a small
population of adults accepting real duties, not a teenager onboarding. Itemised attestation is
also far better evidence than one bundled tick if any of these is ever contested.

### Flow

```
Applies as organizer
  → account created, student-level consent recorded
  → status: pending
  → sees: "Under review" + the full Organizer Agreement to read now
Admin approves
  → NOT yet an organizer
  → next login: Organizer Agreement, full text, 7 checkboxes
  → accepts → legal_acceptances row → verified = 1 → capabilities issued
  → declines → stays a normal account, may accept later
```

**`organizer.approve` must not complete until the acceptance row exists.** The admin action
becomes "authorise this person to become an organizer"; the organizer's own acceptance is what
completes it. That ordering is what makes the agreement binding rather than decorative — and it
is the fix for R-04.

### Re-acceptance

On a MAJOR agreement change: `event.create`, `applicant.review`, `attendance.mark`, and
`message.send` are withheld until re-acceptance. The organizer can still sign in, see existing
events, and read messages. **Existing events keep running** — students are not stranded because
an adult has not read an email. Banner: *"Please review the updated Organizer Agreement to
create new events or message volunteers."*

No grace period here, unlike students. An adult holding minors' contact details under an
agreement they have not accepted is a different proposition from a student who has not re-read
the Terms.

### Suspension implications

Acceptance history is **retained in full** — it is the evidence of what they undertook, and it
becomes more important after suspension, not less. On suspension: capabilities revoked,
`token_version` bumped, active events flagged for admin reassignment, students on upcoming
shifts notified that the event needs a new organizer. On reinstatement, **re-acceptance of the
current agreement is required** regardless of version.

---

## Phase 8 — Safety acknowledgements

### Principle: put it where the risk is, not where the lawyer is

A safety wall at signup is read by nobody — the user is mid-task, motivated to finish, and has
no context for what they are being warned about. The same content shown *at the moment the risk
becomes real* is read, because it is finally relevant.

**Recommendation: one card, plus two contextual notices, and nothing else.**

### 1. First-login safety card — students, once

Shown after first successful login, not during signup. Not a modal over a blank page — it
appears above the dashboard, with the product visible behind it.

```
┌──────────────────────────────────────────────────┐
│  👋 Three things before you start                │
│                                                  │
│  🔒 Your profile is private                      │
│     Only you see it unless you change that.      │
│                                                  │
│  💬 Organizers message you about events          │
│     That's it. If someone asks for your number,  │
│     asks you to keep a secret, or moves the      │
│     conversation to Snapchat — report it.        │
│                                                  │
│  🚩 Reporting is one tap, and it's anonymous     │
│     Every conversation has a Report button. You  │
│     won't get in trouble for using it.           │
│                                                  │
│  [ Got it ]        [ Read the safety guide ]     │
└──────────────────────────────────────────────────┘
```

Recorded as `legal_acceptances` (`youth-safety`, `method='first_login_card'`). Dismissible with
one tap — **it is an acknowledgement, not a gate**, because a safety message that traps you is a
safety message you learn to dismiss without reading.

Content is deliberately three items. The middle one names the three actual grooming patterns
(contact details, secrecy, moving off-platform) in the words a student would use, because
recognising the pattern is what protects them — not knowing the policy exists.

### 2. First adult conversation — contextual, once

The first time a student opens a conversation with an organizer, above the composer:

> 💬 **This is [Name], who runs [Event].** They can message you about this event.
> If they ask for anything else — your number, social media, or to keep something secret —
> **[report it](#)**. You won't get in trouble.

Once per student, not per conversation. This is the single highest-value placement in the
system: it appears at the exact moment the risk begins, naming the specific adult.

### 3. Permanent report affordance

Not an acknowledgement — a control. Every conversation carries a visible Report button at all
times, never behind an overflow menu. Specified in the re-audit's Tier 1 safety requirements.

### What NOT to do

No safety interstitial on every login · no acknowledgement before each message · no scroll-to-
bottom gate on the Youth Safety document · no separate safety checkbox at signup (it competes
with the two that carry legal weight and dilutes both).

**Organizers** get their safety obligations through the Organizer Agreement's itemised
attestations — no separate card. They have already read seven specific commitments; an
additional card would be noise.

---

## Phase 9 — Gaps against the current codebase

| Priority | Gap | Reason | Effort | Risk |
|---|---|---|---|---|
| **P0** | **No consent is recorded anywhere.** `baseFields()` omits `privacyAccepted`; no table exists | Zero evidence any user agreed to anything. Every published policy is unenforceable and every claim of agreement is unprovable | **M** | Total. Unenforceable ToS; indefensible in any dispute |
| **P0** | **Consent control does not render by default.** `{PRIVACY_URL && ...}`, default `''` | A default build presents no consent at all | **XS** | No notice given |
| **P0** | `legal_documents` + `legal_acceptances` tables | Nothing to write to | **M** | — |
| **P0** | Consent block at the true commitment point, **both paths** | Current checkbox is mid-form step 1; OAuth commits at end of step 1 | **M** | OAuth users never asked |
| **P0** | Organizer Agreement acceptance gating `organizer.approve` | An unaccepted agreement has no effect (R-04) | **M** | Adults hold minors' data under nothing |
| **P0** | Guardian consent capture + verification | Only mechanism left carrying enforceability for minors (R-27) | **L** | Voidable agreements; no adult contact |
| **P0** | Admin policy acceptance before capability grant | Admins see everything under no undertaking | **S** | Unconstrained insider access |
| **P1** | Re-consent enforcement middleware | Updates cannot be enforced | **M** | Policy changes are advisory only |
| **P1** | Version publication workflow + content hashing | Versions drift; no proof of what was agreed | **M** | Cannot answer "what did they accept?" |
| **P1** | "Your agreements" in Settings | Transparency; fastest route to a subject-access response | **S** | Requests handled by hand |
| **P1** | First-login safety card | Highest-value safety touchpoint | **S** | Students unbriefed |
| **P1** | First-conversation contextual notice | Warning at the moment risk begins | **S** | — |
| **P1** | Legal Center hub `/legal` | Documents exist but are unreachable in product | **M** | Published ≠ discoverable |
| **P1** | Footer legal row, signed-out included | Baseline discoverability | **XS** | — |
| **P2** | Changelog `/legal/changes` + version archive | Users cannot see what changed or what they accepted | **M** | — |
| **P2** | Client-side search | Findability at scale | **M** | — |
| **P2** | Email-footer legal links | Standard, and CAN-SPAM-adjacent hygiene | **XS** | — |
| **P2** | In-context links at each control | Where documents are actually read | **S** | — |
| **P2** | Boot-time content-hash verification | Detects document tampering | **S** | Silent drift |
| **P3** | Diff view between versions | Nice; changelog summary carries most of the value | **M** | — |
| **P3** | Guardian portal | Beyond notification | **L** | — |
| **P3** | Consent-record export for counsel | Manual query suffices at this scale | **S** | — |

---

## Phase 10 — Implementation roadmap

### Phase A — Critical before launch

| # | Task | Why | Depends on | Risk if skipped | Effort |
|---|---|---|---|---|---|
| A1 | `PRIVACY_URL` defaults to `/privacy`; drop the `&&` wrapper | A default build currently shows no consent control at all | — | No notice given to anyone | 0.25d |
| A2 | Migrations `006_legal_documents`, `007_legal_acceptances` | Nothing can be recorded without them | — | No evidence of agreement | 1d |
| A3 | `recordAcceptance()` in the **same transaction as the user insert** | An account without its consent row is an account that never agreed. Mirrors the `spendChallenge` atomicity rule this codebase already enforces | A2 | Orphaned accounts | 0.5d |
| A4 | Consent block at commitment point, **password and OAuth paths** | OAuth commits at end of step 1; missing it leaves a hole | A2, A3 | OAuth users never asked | 1.5d |
| A5 | Seed `legal_documents` with v1.0 of every published policy + hashes | Acceptances need something to point at | A2 | Dangling references | 0.5d |
| A6 | Guardian consent capture + verification email | Only remaining enforceability mechanism for minors | A2, age gate | Voidable agreements, no adult contact | 3–4d |
| A7 | Organizer Agreement acceptance gating `organizer.approve` | Closes R-04; makes the agreement binding | A2, A3 | Adults hold minors' data under nothing | 1.5d |
| A8 | Admin policy acceptance before capability grant | Closes the insider gap | A2 | Unconstrained access | 0.5d |
| A9 | Footer legal row on every page including signed-out | Baseline discoverability | — | Documents unreachable | 0.5d |

**Phase A total: ~10 days.** A6 is the long pole and depends on the age gate from the re-audit's
Phase B — sequence them together.

### Phase B — Strongly recommended before launch

| # | Task | Why | Depends on | Effort |
|---|---|---|---|---|
| B1 | Re-consent middleware, mirroring `isEmailGateAllowed` | Enforcement of updates; proven pattern in this codebase | A2 | 1.5d |
| B2 | Re-consent interstitial with the three actions + 14-day grace | Users keep access to their own record while declining new terms | B1 | 2d |
| B3 | Legal Center hub `/legal` | Makes everything discoverable | design system | 2d |
| B4 | "Your agreements" in Settings | Transparency; fastest subject-access response | A2 | 1d |
| B5 | First-login safety card | Highest-value safety touchpoint | A2 | 1d |
| B6 | First-conversation contextual notice | Warning where risk begins | — | 1d |
| B7 | Publication workflow + `bin/publish-policy.mjs` | Versions must be reproducible, not hand-managed | A2 | 1.5d |
| B8 | In-context links (leaderboard, delete, export, verify, apply) | Where documents actually get read | B3 | 0.5d |

**Phase B total: ~11 days.**

### Phase C — Shortly after launch

C1 changelog `/legal/changes` (2d) · C2 version archive `/legal/v/:slug/:version` (1d) ·
C3 client-side search (2d) · C4 email-footer legal links (0.5d) · C5 boot-time content-hash
verification, reusing the migration-checksum pattern (1d) · C6 acceptance-record export for
subject-access (0.5d) · C7 remaining policy pages on `LegalLayout` (2d).

### Phase D — Future

D1 side-by-side version diff · D2 guardian portal (view student's agreements, withdraw consent)
· D3 localisation, starting with Spanish · D4 per-jurisdiction document variants if the platform
crosses state lines · D5 signed consent receipts emailed at acceptance · D6 an admin dashboard
over acceptance coverage ("94% of active users are on ToS v1.1").

---

## Tests this system requires

Per `docs/ENGINEERING_GUIDE.md`, any new endpoint, any authz change, and any migration needs tests.

1. Migration idempotency for `006` and `007`
2. Signup writes acceptance rows **in the same transaction** — a forced failure after the user
   insert leaves neither
3. **The OAuth path writes acceptance rows too** — the hole most likely to be missed
4. Signup is refused when consent is absent, on both paths
5. `organizer.approve` cannot complete without an acceptance row at the current version
6. Re-consent middleware allows the allowlist and blocks everything else
7. The 14-day grace expiry moves an account to read-only, and read-only still permits export and
   deletion
8. `ON DELETE RESTRICT` holds — deleting a user does not remove acceptance rows
9. `ip_prefix` is truncated and `ua_family` is parsed — **assert the raw values are never
   persisted**
10. Content hash matches the published document at boot
11. A guardian token is single-use and expires
12. Acceptance records survive account anonymisation with the user id intact

Test 9 is the one that protects the privacy commitment from regressing quietly, and it is the
kind of guard this codebase already favours — a build-failing assertion rather than a comment
asking future maintainers to be careful.
