# WeVolunteer legal document set

Ten documents. Each file opens with a **specification block** — purpose, audience, required
sections, and the decisions WeVolunteer must make — followed by the **draft** itself.

## Conventions used in every draft

**`[[OWNER DECISION — BLOCKS PUBLICATION: ...]]` means a fact nobody has supplied yet.** This
follows the rule already enforced in `src/config.js`: placeholder legal text is worse than no
legal text, because it manufactures the appearance of a reviewed policy. Each marker states the
decision it is waiting on, so `grep -rn "\[\[" docs/legal/policies/` is the publication-blocker
list. **Two remain**, both needing a fact that is not in the repository: the production hosting
provider (01) and the monitored hours for the safety inbox (08).

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
then a version bump that edits one block per document instead of a search-and-replace through ten.

**Reading level target: US grade 8.** These are read by fourteen-year-olds. Sentences stay
short, the second person is used throughout ("you," not "the User"), and every legal concept
is stated in plain words before (never instead of) its precise form.

**No document claims a protection the code does not provide.** Every factual assertion about
system behaviour in these drafts was checked against the schema and route handlers on
`fix/v1.2c-review-findings`. Where behaviour and desired policy differ, the draft describes
the behaviour and flags the gap — it does not describe the aspiration.

## The set

All ten are revised for the **independent-platform** model, operated by a **sole proprietor**.
Every Posture A / district branch is resolved; the operator, jurisdiction, minimum age, privacy
contact and retention periods are filled in.

| # | Document | Audience | Status |
|---|---|---|---|
| 1 | [Privacy Policy](/legal/privacy-policy) | Students, guardians | **Blocked on one item** — the hosting provider. SMTP is resolved (Gmail, so Google); the archive promise is resolved by this being v1.0; the applications retention period it publishes is now enforced in `retentionWorker.js`; safety-report retention is now a stated decision rather than a pending one |
| 2 | [Terms of Service](/legal/terms-of-service) | All users | **Ready, pending counsel confirmation** — liability cap set at $100 with its reasoning in the text; no postal address printed, service arranged on request instead, and the draft says why; archive resolved by v1.0. Counsel should still confirm the cap, the no-arbitration choice and the NJ venue |
| 3 | [Community Guidelines](/legal/community-guidelines) | Students, organizers | **Ready** — enforcement ladder now describes what exists (no expiring suspensions, no warning record), "moderation team" is one person, response times are targets rather than guarantees, and the one-administrator limit on appeals is disclosed |
| 4 | [Data Deletion Policy](/legal/data-deletion-policy) | Students, guardians | **Ready** — the unimplemented certificate-voiding section is removed. It had been contradicting the Privacy Policy on the page a student reads while deciding to delete |
| 5 | [Cookie and Tracking Notice](/legal/cookie-and-tracking-notice) | All | **Ready** — archive resolved by v1.0; diagnostics retention states the real code values |
| 6 | [Certificate Verification Policy](/legal/certificate-verification-policy) | Verifiers, students | **Ready** — verification points at the page rather than a URL that does not resolve yet; the voiding block is replaced with the true position |
| 7 | [Volunteer Record Policy](/legal/volunteer-record-policy) | Students, schools | **Ready** |
| 8 | [Youth Safety Guidelines](/legal/youth-safety-guidelines) | Everyone | **Blocked on monitored hours** — one marker. The "one business day" promise it gated is removed rather than published against a blank, and "reports are not triaged by software" is corrected: software does derive priority. Still wants counsel on the mandated-reporter wording |
| 9 | [Organizer Agreement](/legal/organizer-agreement) | Organizers | **Blocked on the product change** — the text is complete and the counterparty is named, but nothing records acceptance, so it binds nobody |
| 10 | [Admin Responsibilities Policy](/legal/admin-responsibilities-policy) | Admins | **Ready** — approver is the operator (sole holder of `admin.create`); the register is `docs/operations/administrator-register.md`, deliberately outside the app database; review is quarterly |

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

`server/legalDocuments.js` pins a **sha256 of the published body** of all ten documents — the
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

**Hash enforcement is advisory before launch**, by owner decision — see `LEGAL_HASHES_ENFORCED`
in `server/legalDocuments.js` for why, and for the one line that turns it back on. What that
means in practice:

- **The verifier is `server/consent.test.js`** — the "pins a content hash that matches the
  published file" case, `skipIf`'d while enforcement is off and re-armed automatically when it is
  turned on. (Earlier revisions of this file named `server/legalDocuments.test.js`. There is no
  such file and there never was.)
- **`node bin/legal-hashes.mjs`** prints the current hash of every document and reports `DRIFT`
  in both modes. It exits 0 while hashes are advisory, so it is a report rather than a gate.
- The server still serves a drifted file, warns once per slug, and records the hash it actually
  published — so `legal_documents` stays honest even in the mode that stops checking.
- What is **not** relaxed: a missing file or one that has lost its `## Draft` marker still throws
  and still stops a production boot.

At launch: run `node bin/legal-hashes.mjs`, paste the printed values into `LEGAL_DOCUMENTS`, and
set `LEGAL_HASHES_ENFORCED` to `true`. From then on, keep each document's own header, the registry
version, and the pinned hash moving together — that is the drift the pinned hash exists to catch.

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
