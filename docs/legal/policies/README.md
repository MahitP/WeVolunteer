# WeVolunteer legal document set

Ten documents. Each file opens with a **specification block** — purpose, audience, required
sections, and the decisions WeVolunteer must make — followed by the **draft** itself.

## Conventions used in every draft

**`[[BRACKETED]]` means a fact nobody has supplied yet.** This follows the rule already
enforced in `src/config.js`: placeholder legal text is worse than no legal text, because it
manufactures the appearance of a reviewed policy. Every bracketed value must be filled by a
named human before publication, and the publication checklist refuses to pass while any
remain.

**Reading level target: US grade 8.** These are read by fourteen-year-olds. Sentences stay
short, the second person is used throughout ("you," not "the User"), and every legal concept
is stated in plain words before (never instead of) its precise form.

**No document claims a protection the code does not provide.** Every factual assertion about
system behaviour in these drafts was checked against the schema and route handlers on
`fix/v1.2c-review-findings`. Where behaviour and desired policy differ, the draft describes
the behaviour and flags the gap — it does not describe the aspiration.

## The set

All ten are revised for the **independent-platform** model. Every Posture A / district branch is
resolved; the privacy contact and retention periods are filled in.

| # | Document | Audience | Status |
|---|---|---|---|
| 1 | [Privacy Policy](01-privacy-policy.md) | Students, guardians | **Blocked** — the under-13 section still cannot publish; the age gate ships but the section text was never un-blocked |
| 2 | [Terms of Service](02-terms-of-service.md) | All users, guardians | **Blocked** — needs drafting counsel and a legal entity to be a party to it |
| 3 | [Community Guidelines](03-community-guidelines.md) | Students, organizers | **Ready** — the enforcement ladder is now real |
| 4 | [Data Deletion Policy](04-data-deletion-policy.md) | Students, guardians | **Nearly ready** — delete the certificate-void section until that ships |
| 5 | [Cookie and Tracking Notice](05-cookie-and-tracking-notice.md) | All | **Ready** |
| 6 | [Certificate Verification Policy](06-certificate-verification-policy.md) | Verifiers, students | **Ready** |
| 7 | [Volunteer Record Policy](07-volunteer-record-policy.md) | Students, schools | **Ready** |
| 8 | [Youth Safety Guidelines](08-youth-safety-guidelines.md) | Everyone | **Ready** — needs counsel review on the mandated-reporter wording, and a stated monitored-hours value |
| 9 | [Organizer Agreement](09-organizer-agreement.md) | Organizers | **Blocked** — the text is accurate, but nothing records acceptance, so it has no legal effect |
| 10 | [Admin Responsibilities Policy](10-admin-responsibilities-policy.md) | Admins | **Ready** |

## What changed on 2026-08-05

Suspension, blocking, the applicant messaging rule, the age gate, consent recording and
retention enforcement all shipped, so every ⚠️ block describing missing enforcement has been
removed — the documents now describe behaviour that exists.

**Three things still block publication, and none of them are wording:**

1. **No legal entity.** A Terms of Service needs a legal person to be a party to it.
2. **Organizer Agreement acceptance is not recorded.** The text is accurate; nothing stores
   that an organizer accepted it, so it binds nobody.
3. **The under-13 section of the Privacy Policy** was written to publish once the age gate
   existed. It does now — that section needs un-blocking and a final read.

## The publication rule this set is built around

**A document does not publish while it contains a `[[BRACKETED]]` value or a ⚠️ block.**

The ⚠️ blocks mark statements describing functionality the platform does not have. They are
deliberately loud and inline rather than collected in an appendix, because the failure mode is
publishing one by accident.

See [`../06-REAUDIT-POSTURE-B.md`](../06-REAUDIT-POSTURE-B.md) for the current risk register and
the P0–P3 gap analysis.
