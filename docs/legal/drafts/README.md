# Legal drafts

These are drafts for the owner to read, change and publish himself (Phase 4,
item 29 of the final requirements audit). A draft is never live itself: what is
published is a policy file or a Legal Center revision, and the table says which.
Nothing here has been reviewed by a lawyer.

Under Posture B there is no company behind WeVolunteer: every promise these
documents make is a promise the owner makes personally. Read them as that.

| Draft | What it is for | How it would be published |
|---|---|---|
| [acceptable-use-policy.md](acceptable-use-policy.md) | Ruling 13: a separate Acceptable Use Policy. It replaces the text of Terms §4 rather than sitting beside it, so there is one set of rules, not two that can disagree | **Published 2026-10-05** as policy 14, [`14-acceptable-use-policy.md`](../policies/14-acceptable-use-policy.md), taking effect 2026-11-06. The owner chose "we tell you a limit when you reach it" for §5; six rules from Terms §4 the draft had dropped were restored (the policy's specification lists them) |
| [terms-section-13-changes.md](terms-section-13-changes.md) | FX-44: "your responsibility to review changes", added without withdrawing the 30 days' notice §13 already promises. Also corrects §4.2's "for a school district" | **Approved 2026-10-05 as Terms 2.0.0**, effective 2026-11-06. The paste-ready body is [terms-of-service-2.0.body.md](terms-of-service-2.0.body.md): §4 becomes a pointer to the AUP (which removes §4.2's district line with it), §8 links the End-User License, and §13 is this draft corrected against the code (the legal email is mandatory, so it always goes; the list of what is withheld until acceptance is the gate's actual list). The owner publishes it in the Legal Center editor; it passes `validateBody` |
| [welly-privacy-wording.md](welly-privacy-wording.md) | Ruling 14's footer sentence, "what you type stays on your device", is false: a search sends the words searched for, and the server may pass them to Pinecone. Replacement wording for the footer and four other strings that make the same claim | **Approved and applied 2026-10-04.** The info site's sentence replaced the ruling's, and the four other strings changed with it |
| [ai-and-on-device-processing-2.0.md](ai-and-on-device-processing-2.0.md) | The AI policy is behind the code: searches, the iPhone experiment, confirm-first actions, Welly Chat, model sizes, checksums | **Approved as 2.0 on 2026-10-04; the owner publishes it** in the Legal Center editor by pasting [the body](ai-and-on-device-processing-2.0.body.md). A `notice` document, so even a MAJOR version shows a banner and asks nobody to accept |
| [end-user-licence.md](end-user-licence.md) | Ruling 22: an EULA, drafted at the owner's request against the recommendation. It covers only what reaches a device (the home-screen version, the Welly AI model, the app's code) and points to the Terms for everything else | **Published 2026-10-05** as policy 15, [`15-end-user-license.md`](../policies/15-end-user-license.md) (American spelling, like the rest of the app), taking effect 2026-11-06. Corrected: the two offered models only, their real sizes, and "ask legal@" for the full notices list until it is a served page |
| [privacy-policy-search-provider.md](privacy-policy-search-provider.md) | Pinecone is missing from the Privacy Policy's list of outside companies, and so is Hugging Face | **At the launch pass (owner, 2026-10-04)**, staged as Pending Correction 3 in policy 1 and on the launch checklist |
| [privacy-policy-2.0.body.md](privacy-policy-2.0.body.md) | Privacy Policy 2.0: Pending Corrections 1–3 applied, plus every recipient checked against production on 2026-10-12 — Cloudflare, Supabase, Oracle Cloud, Backblaze and Better Stack named; CARTO replaced by the tile proxy; Upstash moved from India to Virginia and described fully; the organizer address-search bias; request records, two-factor records and backups added to the retention table; the stray "This is version 1.1" removed | **Published 2026-10-13** through the Legal Center editor as 2.0.0, effective 2026-11-13 (production hash `aa5bea93…` = this file, trimmed) — MAJOR, so 30 days' notice and every account re-accepts. Passes `validateBody` and `validatePublication` |

Decisions only the owner can make are marked **[OWNER]** in each draft.

The Terms of Service carry acceptance records, so their published text cannot
be edited in place; a change is always a new version. That is enforced by the
server, not by convention.
