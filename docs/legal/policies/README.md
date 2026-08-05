# WeVolunteer legal document set

Ten documents. Each file opens with a **specification block** — purpose, audience, required
sections, and the decisions WeVolunteer must make — followed by the **draft** itself.

## Conventions used in every draft

**`[[TODO: ...]]` means a fact nobody has supplied yet.** This follows the rule already
enforced in `src/config.js`: placeholder legal text is worse than no legal text, because it
manufactures the appearance of a reviewed policy. Every one must be filled by a named human
before publication, and the publication checklist refuses to pass while any remain. Each marker
states the decision it is waiting on, so `grep -rn "\[\[" docs/legal/policies/` is the
publication-blocker list.

Two markers are a different thing and are meant to stay: the `[[NOT YET IMPLEMENTED]]` block in
[04](04-data-deletion-policy.md) and the `[[NOT YET BUILT]]` block in
[06](06-certificate-verification-policy.md). Both hold drafted text for **certificate voiding**,
which is scheduled later in this programme. They block publication of those two documents on
purpose, and whoever ships voiding removes both in the same pull request and updates the Privacy
Policy paragraph that currently says plainly that no such option exists.

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
| 1 | [Privacy Policy](01-privacy-policy.md) | Students, guardians | **Blocked on vendor names** — three `[[TODO]]`s: SMTP provider, hosting provider, archive URL. Text is complete; controller, age, retention and the no-guardian-consent disclosure are all resolved |
| 2 | [Terms of Service](02-terms-of-service.md) | All users | **Blocked on four decisions** — liability cap, postal address, archive URL, counsel sign-off. Structurally complete: acceptable use, split student/organizer responsibilities, IP, appeals, dispute process, NJ law and Middlesex County venue |
| 3 | [Community Guidelines](03-community-guidelines.md) | Students, organizers | **Ready** — enforcement ladder is real; the unkeepable guardian-notification promise is gone |
| 4 | [Data Deletion Policy](04-data-deletion-policy.md) | Students, guardians | **Blocked until certificate voiding ships** — deliberately, by the `[[NOT YET IMPLEMENTED]]` marker. Everything else is publishable |
| 5 | [Cookie and Tracking Notice](05-cookie-and-tracking-notice.md) | All | **Blocked on the archive URL only** — diagnostics retention now states the real code values |
| 6 | [Certificate Verification Policy](06-certificate-verification-policy.md) | Verifiers, students | **Blocked on the public URL**, and on certificate voiding by the same deliberate marker as 04 |
| 7 | [Volunteer Record Policy](07-volunteer-record-policy.md) | Students, schools | **Ready** |
| 8 | [Youth Safety Guidelines](08-youth-safety-guidelines.md) | Everyone | **Blocked on monitored hours** — one `[[TODO]]`, and it gates the "within one business day" promise. Still wants counsel on the mandated-reporter wording |
| 9 | [Organizer Agreement](09-organizer-agreement.md) | Organizers | **Blocked on the product change** — the text is complete and the counterparty is named, but nothing records acceptance, so it binds nobody |
| 10 | [Admin Responsibilities Policy](10-admin-responsibilities-policy.md) | Admins | **Blocked on three operational decisions** — approver, register location, review cadence |

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
