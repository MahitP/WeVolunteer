# Legal drafts — not published

These are drafts for the owner to read, change and publish himself (Phase 4,
item 29 of the final requirements audit). Nothing here is live, nothing here is
linked from the product, and nothing here has been reviewed by a lawyer.

Under Posture B there is no company behind WeVolunteer: every promise these
documents make is a promise the owner makes personally. Read them as that.

| Draft | What it is for | How it would be published |
|---|---|---|
| [acceptable-use-policy.md](acceptable-use-policy.md) | Ruling 13: a separate Acceptable Use Policy. It replaces the text of Terms §4 rather than sitting beside it, so there is one set of rules, not two that can disagree | A new Legal Center document needs a code change (an entry in `server/legalDocuments.js` and a policy file), and Terms §4 becomes a pointer to it in a new Terms version |
| [terms-section-13-changes.md](terms-section-13-changes.md) | FX-44: "your responsibility to review changes", added without withdrawing the 30 days' notice §13 already promises. Also corrects §4.2's "for a school district" | A new Terms version from the Legal Center editor. Because it changes what a reader agreed to, it is a MAJOR version and asks every account to accept again |
| [welly-privacy-wording.md](welly-privacy-wording.md) | Ruling 14's footer sentence, "what you type stays on your device", is false: a search sends the words searched for, and the server may pass them to Pinecone. Replacement wording for the footer and four other strings that make the same claim | A code change, once the owner approves the replacement for his ruling. The tests that must change with it are listed |
| [ai-and-on-device-processing-2.0.md](ai-and-on-device-processing-2.0.md) | The AI policy is behind the code: searches, the iPhone experiment, confirm-first actions, Welly Chat, model sizes, checksums | A new version from the Legal Center editor. A `notice` document, so even a MAJOR version shows a banner and asks nobody to accept |
| [privacy-policy-search-provider.md](privacy-policy-search-provider.md) | Pinecone is missing from the Privacy Policy's list of outside companies, and so is Hugging Face | At the launch pass with Pending Corrections 1 and 2, or sooner by one of the routes the note lists |

Decisions only the owner can make are marked **[OWNER]** in each draft.

The Terms of Service carry acceptance records, so their published text cannot
be edited in place; a change is always a new version. That is enforced by the
server, not by convention.
