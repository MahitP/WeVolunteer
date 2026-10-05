# WeVolunteer legal document set

Thirteen documents. Each file opens with a **specification block** — purpose, audience, required
sections, and the decisions WeVolunteer must make — followed by the **draft** itself.

## These files are the baseline, not always what is being served (v1.4)

The Legal Center editor (`/admin/legal`, owner only) publishes revisions into
`legal_document_revisions`, and a row there **supersedes the file** for that slug. So a
document's live text and version may differ from what is written here.

What that changes, and what it does not:

- **These files stay the record of what was originally published**, and the fallback for any
  document nobody has edited. Nothing at runtime rewrites them — the server never writes to
  `docs/`.
- **Editing a file still requires the version and hash procedure below**, because a file edit
  only takes effect for documents with no revision.
- **Editing through the editor requires a strictly greater version**, enforced on the server.
  That is not a preference: `legal_documents` is keyed by `(slug, version)` and a published row
  is immutable, so reusing a version makes the catalogue disagree with the acceptance records
  pointing at it.
- **The registry still owns everything that is not content** — slug, title, summary, scope,
  consent type, bundling. The editor cannot change any of them.

`server/legalStore.js` is the single place that decides which of the two answers applies.

## Conventions used in every draft

**`[[OWNER DECISION — BLOCKS PUBLICATION: ...]]` means a fact nobody has supplied yet.** This
follows the rule already enforced in `src/config.js`: placeholder legal text is worse than no
legal text, because it manufactures the appearance of a reviewed policy. Each marker states the
decision it is waiting on, so `grep -rn "\[\[" docs/legal/policies/` is the publication-blocker
list. **None remain.** The last two — the production hosting provider (01) and the monitored
hours for the safety inbox (08) — were resolved into prose rather than left as blanks, and the
grep now matches only the specification blocks that *describe* markers which have been removed.
That is worth knowing before trusting the grep: a hit above a `## Draft` marker is a note about
history, not a blocker.

**The two `[[NOT YET IMPLEMENTED]]` / `[[NOT YET BUILT]]` blocks are gone, and how they went is
worth recording.** Both held drafted text for certificate voiding, a feature that is not built.
The one in [04](/legal/data-deletion-policy) had a problem the marker did not describe: the
drafted text sat in the published body under a real heading, so the Data Deletion Policy told a
student choosing whether to delete their account that they could void their certificates — while
the Privacy Policy in the same set said plainly that no such option exists. A reader hit the
false version at the exact moment of deciding. Both blocks are replaced with the true position.
Whoever ships voiding adds the option to all three documents together; nothing is now holding
drafted text in a published body waiting for them.

**The operator is named in exactly one marked block per document.** Every document that has to
identify the legal entity carries a single blockquote beginning **THE OPERATOR**, and says "we"
everywhere else. A change of legal form — sole proprietor to LLC, corporation, or nonprofit — is
then a version bump that edits one block per document instead of a search-and-replace through thirteen.

**Reading level target: US grade 8.** These are read by fourteen-year-olds. Sentences stay
short, the second person is used throughout ("you," not "the User"), and every legal concept
is stated in plain words before (never instead of) its precise form.

**No document claims a protection the code does not provide.** Every factual assertion about
system behaviour in these drafts was checked against the schema and route handlers on
`fix/v1.2c-review-findings`. Where behaviour and desired policy differ, the draft describes
the behaviour and flags the gap — it does not describe the aspiration.

## The set

All fifteen are written for the **independent-platform** model, operated by a **sole proprietor**.
Every Posture A / district branch is resolved; the operator, jurisdiction, minimum age, privacy
contact and retention periods are filled in.

| # | Document | Audience | Status |
|---|---|---|---|
| 1 | [Privacy Policy](/legal/privacy-policy) | Students, guardians | **Blocked on one item** — the hosting provider. SMTP is resolved (**Resend** primary, Gmail as the fallback route — the table in the draft is the authority); the archive promise is resolved by this being v1.0; the applications retention period it publishes is now enforced in `retentionWorker.js`; safety-report retention is now a stated decision rather than a pending one |
| 2 | [Terms of Service](/legal/terms-of-service) | All users | **Ready, pending counsel confirmation** — liability cap set at $100 with its reasoning in the text; no postal address printed, service arranged on request instead, and the draft says why; archive resolved by v1.0. Counsel should still confirm the cap, the no-arbitration choice and the NJ venue |
| 3 | [Community Guidelines](/legal/community-guidelines) | Students, organizers | **Ready** — enforcement ladder now describes what exists (no expiring suspensions, no warning record), "moderation team" is one person, response times are targets rather than guarantees, and the one-administrator limit on appeals is disclosed |
| 4 | [Data Deletion Policy](/legal/data-deletion-policy) | Students, guardians | **Ready** — the unimplemented certificate-voiding section is removed. It had been contradicting the Privacy Policy on the page a student reads while deciding to delete |
| 5 | [Cookie and Tracking Notice](/legal/cookie-and-tracking-notice) | All | **Ready** — archive resolved by v1.0; diagnostics retention states the real code values |
| 6 | [Certificate Verification Policy](/legal/certificate-verification-policy) | Verifiers, students | **Ready** — verification points at the page rather than a URL that does not resolve yet; the voiding block is replaced with the true position |
| 7 | [Volunteer Record Policy](/legal/volunteer-record-policy) | Students, schools | **Ready** |
| 8 | [Youth Safety Guidelines](/legal/youth-safety-guidelines) | Everyone | **Blocked on monitored hours** — one marker. The "one business day" promise it gated is removed rather than published against a blank, and "reports are not triaged by software" is corrected: software does derive priority. Still wants counsel on the mandated-reporter wording |
| 9 | [Organizer Agreement](/legal/organizer-agreement) | Organizers | **Ready** — acceptance is recorded. `server/organizerAgreement.js` gates the organizer role on it and re-asks when the version moves, so it no longer binds nobody. Was "blocked on the product change" until that shipped |
| 10 | [Admin Responsibilities Policy](/legal/admin-responsibilities-policy) | Admins | **Ready** — approver is the operator (sole holder of `admin.create`); the register is `docs/operations/administrator-register.md`, deliberately outside the app database; review is quarterly |
| 11 | [Student Organizer Agreement](/legal/student-organizer-agreement) | Student organizers | **Ready** — acceptance is recorded and gated by `server/studentOrganizerAgreement.js`. Deliberately stricter and shorter than 09: a student helping run a club is handling their peers' details, and the two-adult rule in 09 does not transfer to them |
| 12 | [AI and On-Device Processing Policy](/legal/ai-and-on-device-processing) | All | **Ready** — `notice`, not `acknowledge`: the assistant is opt-in and off by default, and the enable screen is where the decision is actually made. Briefly 2.0 for a dictation section; the control was withdrawn before release and the section went with it, so it says what 1.0 said |
| 13 | [Accessibility Statement](/legal/accessibility-statement) | All | **Ready** — states a WCAG 2.2 AA target, what was tested, what is known broken, and how to report a barrier. Deliberately does **not** claim ADA compliance |
| 14 | [Acceptable Use Policy](/legal/acceptable-use-policy) | All | **Ready, takes effect 2026-11-06** — the rules from Terms §4, §4.1 and §4.2 in one place (ruling 13), plus appeal spam, limits, disruption and enforcement. `notice`: part of the Terms. Terms 2.0, published through the editor with the same effective date, replaces §4 with a pointer here |
| 15 | [End-User License](/legal/end-user-license) | All | **Ready, takes effect 2026-11-06** — only the software that ends up on a device (ruling 22); everything else points to the Terms. `notice`: adds no obligation, so nobody re-accepts |

## What changed on 2026-08-05

**Morning.** Suspension, blocking, the applicant messaging rule, the age gate, consent recording
and retention enforcement all shipped, so every ⚠️ block describing missing enforcement was
removed — the documents describe behaviour that exists.

**Afternoon — the legal pass.** The operator, jurisdiction, and age policy were decided and
written in; the Terms were completed against their required-section list; and three documents were
found to describe things that are not true and were corrected:

1. **The Privacy Policy offered a certificate-void option that does not exist.** It now states
   plainly that no way to switch off indefinite certificates exists today.
2. **The Community Guidelines promised to notify a parent or guardian of a suspension.** No
   guardian contact detail is collected anywhere in the schema, so that could not be kept for
   anybody. Replaced with what actually happens.
3. **The published error-diagnostics retention was wrong** — "90 days" against real code values of
   30 / 30 / 180 / 7 days. Corrected in both documents that state it.

**The publication blockers are now nine external inputs and one product change**, and none of
them are wording:

1. **Liability cap figure** (Terms) — owner and counsel.
2. **Postal address** (Terms) — may need a mail-forwarding decision first.
3. **Counsel sign-off** on the no-arbitration choice and the NJ / Middlesex County venue.
4. **SMTP provider** and **5. hosting provider** (Privacy Policy) — vendor selection.
6. **Public URL**, and **7. the policy-archive URL** derived from it — appears in three documents.
8. **Monitored hours** for the safety inbox (Youth Safety) — gates the response-time promise.
9. **Approver, register location, and review cadence** (Admin Responsibilities).
10. **Organizer Agreement acceptance is not recorded.** The one that is engineering: nothing
    stores that an organizer accepted it, so the highest-value document in the set binds nobody.

**Certificate voiding is scheduled, not abandoned**, which is why 04 and 06 keep their markers.

## Versioning — read before publishing

`server/legalDocuments.js` pins a **sha256 of the published body** of all fifteen documents — the
half below the `## Draft` marker, so editing the specification block above it does not invalidate
anybody's acceptance record.

**Every document is at version 1.0, and stays there until launch.** The drafting numbers that
reached 2.1, 2.2 and 3.0 were reset, because a version number exists to answer "what did this
person agree to, and when" and nothing here has ever been published to a real person. Shipping a
Terms of Service at 2.0 would tell the first reader they are looking at the second revision of a
contract whose first revision nobody can produce. The reasoning is recorded in full at the top of
`LEGAL_DOCUMENTS` in `server/legalDocuments.js`; the reset was available exactly once and has been
used. **Do not bump a version to record a pre-launch wording fix.** MAJOR/MINOR applies from the
first published release forward.

**Hash enforcement is ON.** `LEGAL_HASHES_ENFORCED` is `true` in
`server/legalDocuments.js`; this section used to describe the advisory mode that preceded it and
told you to turn it on at launch, which has been done. Read the constant's own comment for why it
was flipped — the short version is that advisory mode is exactly why three published documents
had drifted out of agreement with the application without anyone noticing.

What that means in practice:

- **The verifier is `server/consent.test.js`** — the "pins a content hash that matches the
  published file" case, now armed. (Earlier revisions of this file named
  `server/legalDocuments.test.js`. There is no such file and there never was.)
- **`node bin/legal-hashes.mjs`** prints the current hash of every document and reports `DRIFT`.
  With enforcement on it **exits non-zero**, so it is a gate rather than a report.
- **A production server refuses to boot** on a drifted document rather than serving it. In
  advisory mode it served the file, warned once per slug, and rewrote the recorded hash — which
  is the behaviour that let the drift accumulate.
- Also not relaxed, and never was: a missing file, or one that has lost its `## Draft` marker,
  throws and stops a production boot.

**Editing a published policy is therefore no longer just an edit.** It is: change the file, run
`node bin/legal-hashes.mjs`, paste the printed constant into `LEGAL_DOCUMENTS`, and decide
MAJOR/MINOR by the rule above. That friction is the feature. Keep each document's own header, the
registry version, and the pinned hash moving together — that is the drift the pin exists to
catch.

### What MAJOR and MINOR actually DO, now that they do something

Until v1.5 the distinction was a rule written down here and enforced by nothing except judgement.
It is now the input to the notification system, and the consequences differ enough that they are
worth reading before choosing a number. `server/legalConsentGate.js` is the single place the rule
lives; everything below is derived from it.

**A MINOR or PATCH bump** on any document produces the ordinary change notice — a quiet banner in
the signed-in shell, in the same slot and the same treatment as the location opt-in, offering a
link to the document and a dismiss control. Dismissing it writes `legal_change_notices`, which is
deliberately **not** the consent table: nobody's dismissal of a banner ever becomes evidence that
they agreed to something.

**A MAJOR bump on a `scope: 'signup'` document** — the Terms, the Privacy Policy, the Community
Guidelines — does considerably more. From the version's own **effective date**:

- every account that had accepted an earlier version is shown a dialog it cannot dismiss, offering
  the document, an accept, and a sign-out;
- and until it accepts, the platform **withholds the participation capabilities** from that
  account server-side: applying to events, messaging, posting, creating events, adding hours. The
  list is `SIGNUP_CONSENT_GATED_CAPABILITIES` and it deliberately does not include reading, editing
  your own account, marking attendance, resolving reports, or `legal.edit` — so an owner who
  publishes a MAJOR version by mistake keeps every power needed to publish the correction.

**Between publication and the effective date, nothing is withheld.** §13 of the Terms promises
notice "at least 30 days before it takes effect", so a MAJOR revision dated in the future is
announced — by email, in the notification centre and by the in-app banner, all worded as advance
notice and naming the date — and only becomes mandatory when that date arrives. The TEXT is public
from the moment you save; only the obligation waits.

**The editor enforces the 30 days.** A MAJOR version of a signup document dated sooner than
`MATERIAL_NOTICE_DAYS` (30) ahead is refused, with the earliest legal date named in the message.
The date picker's floor moves with it. Two things to check when you meet that refusal:

1. **Is it really material?** If the change does not leave anybody worse off it is a clarification
   under §13's own test — give it a MINOR version and no notice period applies.
2. **Is something obliging it sooner?** A regulator, a subprocessor withdrawn for a security
   failure, a clause that turns out to be unlawful. Then use the override.

**The notice-period override.** The panel offers "Something obliges this to take effect sooner",
which opens a required written reason (40–500 characters). It is:

- never the default — the floor applies unless you open the panel and write something;
- owner-only and step-up gated, because it inherits the editor's own `legal.edit` + AAL2 gate;
- **audited under its own action**, `LEGAL_NOTICE_PERIOD_OVERRIDDEN`, with your name, the date
  chosen, the date the rule wanted, and your reason — searchable in the Audit Explorer, which
  filters on `SELECT DISTINCT action`;
- refused when it was not needed, so an override cannot sit in the trail against a publication
  that gave the full notice anyway.

It changes which effective dates are accepted and **nothing else**. The acceptance requirement,
the capability withholding and the hash-pinned consent record are untouched, and the reader still
receives the material notice.

### How people are told

Three channels, from one decision. `dispatchLegalChangeNotices` runs inside
`runNotificationSweep` — at boot and every fifteen minutes — and for each account that is behind on
a published revision it enqueues **one** notification through the platform's existing
`notificationService`, which writes the in-app row and the email job:

| | MINOR / PATCH | MAJOR (signup document) |
|---|---|---|
| Event | `LEGAL_DOCUMENT_UPDATED` | `LEGAL_ACCEPTANCE_REQUIRED` |
| In-app banner | yes, dismissible | advance notice until effective, then the mandatory dialog |
| Notification centre | yes, IMPORTANT (kept 365 days) | yes, CRITICAL |
| Email | "we updated this, nothing to do" | "significant change, effective *date*, you will be asked to accept" |

**One legal change, one message.** The two events are mutually exclusive and chosen by severity, so
a material change never produces the ordinary email as well — and the effective date arriving does
not send a second one, because the in-app dialog is the second touch and it is unavoidable.

**Deduplication is a lease, not a log.** `recordNotified` performs a conditional insert on
`legal_change_notices(user_id, slug, version)` and returns whether *this* call claimed it; the claim
and the enqueue commit in one transaction. So refreshing, signing out and in, a restart, several
processes or four concurrent sweeps produce exactly one message, and a rolled-back enqueue leaves
the lease open for the next pass to retry.

**These are mandatory notices.** Both events are in `MANDATORY_NOTICE_EVENTS`, so they are sent
over the global email opt-out and the per-category preference — the Privacy Policy already
publishes "Security emails cannot be switched off", and a notification preference cannot be a way
to opt out of being told that the agreement you are held to has been rewritten. The notification
preferences panel says so in place.

**Email is a channel, never an authority.** Nothing in the delivery path can release a withheld
capability or satisfy a re-consent, and nothing about a provider outage changes what is enforced:
`signupConsentWithholdingsFor` reads acceptance rows and the effective date and never reads
`notified_at`. A failed send is retried by the notification job with the worker's backoff and
five-attempt ceiling; a delivered one is deleted.

**Four states, kept apart.** `notified_at` (we told them) · `acknowledged_at` (they dismissed the
banner) · a `legal_acceptances` row (they agreed) · viewing the document (nothing at all). Only an
authenticated `POST /api/legal/updates/accept` writes the third, and it refuses any version other
than the one in effect.

**An account with no acceptance row for a document is never gated.** That covers every seeded and
legacy account: there is no previous version they were shown, so there is nothing they can be asked
to re-accept.

**The two onboarding agreements are unaffected by all of this.** The Organizer Agreement and the
Student Organizer Agreement have had their own re-acceptance gate since v1.0 — matched on
`(slug, version)`, so *any* bump re-withholds their capabilities and sends the holder to
`/organizer-agreement`. They are excluded from the notice system entirely rather than given a
second surface, so publishing one produces no banner and no dialog: it produces the screen it
always did.

**Links between these documents are checked by `server/legalContent.test.js`.** It extracts links
by running the published body through the real renderer (`src/utils/policyMarkdown.js`) rather
than a regex of its own, and fails the build on a `.md` path, an unregistered slug, a `#fragment`
naming no heading, or anything link-shaped the renderer would print as literal text. Write
cross-references as `/legal/<slug>` or `/legal/<slug>#<heading-slug>`, never as a filename.

## The publication rule this set is built around

**A document does not publish while it contains a `[[BRACKETED]]` value or a ⚠️ block.**

The ⚠️ blocks mark statements describing functionality the platform does not have. They are
deliberately loud and inline rather than collected in an appendix, because the failure mode is
publishing one by accident.

See [`../06-REAUDIT-POSTURE-B.md`](../06-REAUDIT-POSTURE-B.md) for the current risk register and
the P0–P3 gap analysis.
