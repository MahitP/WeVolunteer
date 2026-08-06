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
The one in [04](04-data-deletion-policy.md) had a problem the marker did not describe: the
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
| 1 | [Privacy Policy](01-privacy-policy.md) | Students, guardians | **Blocked on one item** — the hosting provider. SMTP is resolved (Gmail, so Google); the archive promise is resolved by this being v1.0; the applications retention period it publishes is now enforced in `retentionWorker.js`; safety-report retention is now a stated decision rather than a pending one |
| 2 | [Terms of Service](02-terms-of-service.md) | All users | **Ready, pending counsel confirmation** — liability cap set at $100 with its reasoning in the text; no postal address printed, service arranged on request instead, and the draft says why; archive resolved by v1.0. Counsel should still confirm the cap, the no-arbitration choice and the NJ venue |
| 3 | [Community Guidelines](03-community-guidelines.md) | Students, organizers | **Ready** — enforcement ladder now describes what exists (no expiring suspensions, no warning record), "moderation team" is one person, response times are targets rather than guarantees, and the one-administrator limit on appeals is disclosed |
| 4 | [Data Deletion Policy](04-data-deletion-policy.md) | Students, guardians | **Ready** — the unimplemented certificate-voiding section is removed. It had been contradicting the Privacy Policy on the page a student reads while deciding to delete |
| 5 | [Cookie and Tracking Notice](05-cookie-and-tracking-notice.md) | All | **Ready** — archive resolved by v1.0; diagnostics retention states the real code values |
| 6 | [Certificate Verification Policy](06-certificate-verification-policy.md) | Verifiers, students | **Ready** — verification points at the page rather than a URL that does not resolve yet; the voiding block is replaced with the true position |
| 7 | [Volunteer Record Policy](07-volunteer-record-policy.md) | Students, schools | **Ready** |
| 8 | [Youth Safety Guidelines](08-youth-safety-guidelines.md) | Everyone | **Blocked on monitored hours** — one marker. The "one business day" promise it gated is removed rather than published against a blank, and "reports are not triaged by software" is corrected: software does derive priority. Still wants counsel on the mandated-reporter wording |
| 9 | [Organizer Agreement](09-organizer-agreement.md) | Organizers | **Blocked on the product change** — the text is complete and the counterparty is named, but nothing records acceptance, so it binds nobody |
| 10 | [Admin Responsibilities Policy](10-admin-responsibilities-policy.md) | Admins | **Ready** — approver is the operator (sole holder of `admin.create`); the register is `docs/operations/administrator-register.md`, deliberately outside the app database; review is quarterly |

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

`server/legalDocuments.js` pins a **sha256 of the published source** of documents 01, 02, and 03
and `server/legalDocuments.test.js` fails the build when a file changes without the pinned hash
changing. That guard is working as designed: **this pass changed all three, so that test now
fails until the registry is updated.**

Fixing it is two steps, and the second one is a judgement call, not a formality:

1. Run `node bin/legal-hashes.mjs` and paste the refreshed `contentHash` values in.
2. **Bump the versions.** By the registry's own rule — MAJOR when a reasonable reader of the
   previous version would be surprised or worse off — the recommendation is:
   - **Terms of Service → 2.0.** New organizer obligations, a liability cap, and a governing-law
     and venue clause. Requires re-acceptance.
   - **Privacy Policy → 2.0.** A retention period changed (diagnostics), and a stated option
     was withdrawn (certificate voiding). Both are explicitly MAJOR triggers.
   - **Community Guidelines → 2.0.** Bundled with the Terms and re-accepted with them; a
     notification the reader may have been relying on was removed.

Each document's own header now states its version. Keep the header, the registry, and the pinned
hash moving together — that is the drift the pinned hash exists to catch.

## The publication rule this set is built around

**A document does not publish while it contains a `[[BRACKETED]]` value or a ⚠️ block.**

The ⚠️ blocks mark statements describing functionality the platform does not have. They are
deliberately loud and inline rather than collected in an appendix, because the failure mode is
publishing one by accident.

See [`../06-REAUDIT-POSTURE-B.md`](../06-REAUDIT-POSTURE-B.md) for the current risk register and
the P0–P3 gap analysis.
