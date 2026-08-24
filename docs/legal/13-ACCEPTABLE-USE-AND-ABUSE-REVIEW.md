# Acceptable use, automation and abuse — review and decisions

**Date:** 2026-08-25. **Scope:** whether WeVolunteer needs an Acceptable Use
Policy, a DMCA policy or an EULA; what its automation policy should be; whether
pending applications should influence Auto Select; and what limits should bound
application volume and service abuse.

Read this before reopening any of those questions. Several were answered "no",
and a "no" with reasoning is worth more than an unexamined "yes" — but only if
the reasoning is findable.

---

## Decision summary

| Area | What existed | Decision | Where it landed |
|---|---|---|---|
| Acceptable Use Policy | Terms § 4, already labelled "This is the acceptable-use section" | **No separate document.** Extend § 4 | `02-terms-of-service.md` § 4 |
| Service disruption / DoS | The single word "overload", inside another bullet | **Add explicit clauses**; infrastructure handles volumetrics | § 4 bullets 2–3 |
| Rate-limit circumvention | Absent from all thirteen documents | **Add** | § 4 bullet 2 |
| Exploiting a bug | Absent | **Add** | § 4 bullet 4 |
| Malware | Absent (zero occurrences of malware/malicious/virus in the set) | **Add** | § 4 bullet 5 |
| Responsible disclosure | No channel anywhere; § 4 said probing breaches the terms | **Add a channel and a good-faith promise** | § 4.2 |
| Automation of applications | Flat prohibition on "bots or scripts" | **Permit, with one line drawn** | § 4.1 |
| DMCA | One informal paragraph | **Procedure yes, agent registration no** | § 8 |
| EULA | Nothing | **Not appropriate.** Terms are the right instrument | — |
| OSS attribution | No notices anywhere; bundle ships none | **Inventory now; delivery is an open item** | `THIRD-PARTY-NOTICES.md` |
| Auto Select ← pending applications | Not an input | **Do not add** | unchanged |
| Outstanding application cap | None, at any layer | **Add, counting events not rows** | `PENDING_APPLICATION_LIMIT` |
| Application rate limit | None beyond the blanket per-IP `/api` ceiling | **Add, keyed on the user** | `APPLICATION_RATE_LIMIT` |
| Signup volume | Uncounted successes; 10 failures per campus | **Both halves wrong; both fixed** | `SIGNUP_RATE_LIMIT` |

---

## Why no Acceptable Use Policy

Terms § 4 opens with the sentence "This is the acceptable-use section." It
already prohibited scraping, bulk download, bots and scripts, resale, breaking,
probing and circumventing security, accessing records you were not given,
multi-accounting, evading a block, influencing an Auto Select draw by any means
other than volunteering, false reports, off-topic solicitation and illegal
content.

A separate AUP would have restated that. The set is at thirteen documents, each
carrying its own operator blockquote and version discipline, and the Legal
Center's own grouping code had already quietly misfiled one of them. The cost of
a fourteenth is real and the benefit was zero.

The gaps were **inside** § 4, and a topic-coverage pass over all thirteen
documents is what found them. Each of these appeared nowhere in the set:

- getting around a rate limit, an application limit or a block, rather than
  working within it
- deliberately degrading availability — "overload" was one word inside a bullet
  about security, and there was no clause about the service's availability as
  such
- exploiting obviously-unintended behaviour instead of reporting it
- malware

## The automation policy, and why it is not a ban

**The rule: a commitment to turn up has to be made by a person.** Reading your
own data, calendar synchronisation, opportunity alerts and assistive technology
are explicitly permitted. Unattended submission, acceptance or cancellation is
not.

Three objections to student automation were considered and only one survived.

**Fairness — mostly does not apply.** The intuition is that a script wins a race
against a human. But Auto Select is a *weighted random draw held after the
application deadline*, so applying earlier confers nothing at all on the
platform's flagship selection path. This is the single most important fact in the
whole automation question and it is easy to miss.

**Load and slot-hoarding — real, and now handled at the right layer.** A policy
sentence does not stop a script; `APPLICATION_RATE_LIMIT` and
`PENDING_APPLICATION_LIMIT` do. Putting the control in the Terms alone would have
been the appearance of a fix.

**The one that survived: an application is a promise about a child.** An
organizer plans staffing around accepted volunteers, and a student who did not
know a script had committed them cannot keep a promise they never made. That is
what the rule protects, and it is why the line is *unattended* submission rather
than automation as such.

**The assistive-technology carve-out is load-bearing, not decoration.** A blanket
ban on automated interaction sits badly beside an Accessibility Statement
committing to WCAG 2.2 AA, and would bite hardest on the students least able to
argue about it.

Rate limits and the application limit are published rather than hidden, so a
student writing a tool can respect them, and § 4.1 gives an address to ask at
before running something.

## DMCA: procedure yes, registration no

**Implemented:** what to include in a complaint, that content usually comes down
while it is examined, a counter-notice route stated so a student whose work was
wrongly removed knows they can object without a lawyer, and a repeat-infringer
consequence.

**Not implemented:** registration of a designated agent with the U.S. Copyright
Office, and § 8 now says so explicitly rather than leaving a reader to assume
otherwise.

The reasoning. The safe harbour from monetary liability for user-stored material
is conditioned on registering an agent and publishing their contact details, and
it is not free: a fee, renewal every three years, and — for a platform operated
by one private individual — a name and address published in a public directory.
**A lapsed registration is worse than never registering**, because it advertises
reliance on a protection that has expired.

Against that cost, the exposure. User-generated content here is a bio, a skills
list, comments on event pages, private messages, and a profile picture that is
re-encoded to a 192-pixel WebP under 5 KB. The platform charges nothing and shows
no advertising, so vicarious liability's "direct financial benefit" limb is hard
to reach, and contributory liability needs knowledge plus material contribution —
which a take-it-down-on-report practice is precisely designed to avoid.

> **Owner decision, with counsel.** Whether to register is a business judgement
> about appetite for a small residual risk versus publishing a private
> individual's contact details. This review does not make it; it removes the
> implication that it had been made. If the platform ever carries advertising,
> charges for anything, or begins hosting substantial media, revisit this first.

## EULA: not the right instrument

A EULA exists to grant rights that would otherwise be infringed by copying and
executing software, and to characterise the user as a licensee rather than an
owner. Neither applies to hosted access: the code runs on the server, no copy is
transferred, and there is nothing to license. Terms of Use are the correct
instrument and the platform already has them.

Two further reasons not to reach for one. WeVolunteer does not own the
client-shipped third-party code and cannot grant rights in it — the upstream
licences already run to every recipient. And the users are minors, so anything
built on assent is of uncertain enforceability; adding a second assent-based
instrument would multiply that problem rather than solve anything.

**But the question surfaced an obligation that does exist.** React, Leaflet,
pdf.js and the WebAssembly build of llama.cpp are *copied to every browser*, and
MIT, BSD-2-Clause and Apache-2.0 all attach notice conditions to copies with no
hosted-application exception. The bundle ships no notices at all. See
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md), which also records two
things no tool in this repository would have surfaced: `react-leaflet` is under
the **Hippocratic License 2.1**, whose notice clause terminates the licence 30
days after uncured written notice and which is not OSI-approved; and
llama.cpp/ggml is a git submodule compiled into wllama's `.wasm`, so it is the
largest binary shipped to a browser and appears in no npm tree.

## Auto Select: pending applications are not an input, and should not be

Within a single event **every candidate is already pending** — the draw's pool is
exactly `status = 'pending'` on the slot. So the proposal can only mean counting a
student's pending applications on *other* events, which nothing currently reads.

Four reasons not to:

1. **It penalises the behaviour the platform tells students to adopt.** Students
   cannot see applicant counts, so they cannot judge which events are
   oversubscribed; applying broadly is the rational response to that uncertainty,
   and the launch roadmap treats spreading applications as something to
   *support*. A weighting penalty would punish prudence.
2. **It is defeated by one well-timed withdrawal.** Withdrawing is free,
   instantaneous and leaves no durable record — deliberately, so that withdrawing
   by mistake costs a student nothing. A student who understood the term would
   clear their queue before a known draw and re-apply after. The students who
   would work that out are exactly the technically sophisticated ones the
   proposal was aimed at, so it would make the automation problem *worse*.
3. **The unit is ambiguous in a way that penalises commitment.** Applications are
   per shift, so a volunteer who takes three shifts of one festival holds three
   pending applications for one opportunity.
4. **It would change a published, deliberately exhaustive list.** The Volunteer
   Record Policy enumerates every input and closes with "or anything else about
   who you are". This codebase already has one incident where the code and that
   published formula diverged silently.

**What was done instead.** The harm the proposal was reaching for — a student
holding places they will not take — is a business-state problem, and it now has a
business-state control: `PENDING_APPLICATION_LIMIT`, counting distinct events, at
the layer that can actually enforce it. And a genuine correctness defect in the
draw was fixed: it weighed hours from cancelled events, which the student's own
profile excludes, penalising them for somebody else's cancellation.

## Open items

**For the owner:**

1. **DMCA agent registration** — see above. Needs counsel.
2. **Delivering the OSS notices.** A `/licenses` route is the durable fix and the
   only one that can cover the wasm-embedded code. It adds product surface, so it
   is a product decision. `esbuild: { legalComments: 'eof' }` was tried and does
   not work — Vite's top-level esbuild options do not reach the minifier — and was
   deliberately not left in the config.
3. **`react-leaflet`'s Hippocratic 2.1 licence.** Acceptable to this district? It
   is a thin binding over Leaflet (BSD-2-Clause), so there is a path out.

**Engineering, found in passing and deliberately not fixed here:**

4. **Auto Select does not check time overlap.** `computeDraw` never looks at
   other slots' times, so two independent draws can accept the same student into
   two overlapping shifts, and nothing detects it afterwards. The apply-time
   conflict check catches this at application time but is overridable and only
   sees applications that already exist. Left alone because the fix is a genuine
   product choice with two defensible answers — refuse to select into an
   overlapping slot, changing draw outcomes, or accept and notify — and that is
   the owner's call, not a defect with one correct repair.
5. **`GET /api/events` returns the full result set when `limit` is omitted**, and
   that is deliberate: the SPA uses the response as a complete local index, so a
   silently truncated default would show a student the wrong calendar rather than
   erroring. Measured cost is 572 ms at 50,000 events against a realistic school
   year of about a hundred. A warning threshold at 400 rows makes the ceiling
   visible. No change recommended.
6. **Every rate limit is in-process memory** and resets on restart, with no
   process supervision shipped. `instanceLock.js` documents the single-instance
   invariant this depends on. Not a new finding, but it is what the limits above
   rest on.

## What this review did not establish

Primary-source verification of § 512's current fee and renewal mechanics was not
completed in this pass. The DMCA decision rests on the structure of the
safe harbour and on the cost/benefit above, both of which are robust to those
details — registration is either worth publishing a private address for or it is
not — but the specifics should be confirmed before anybody acts on item 1.

Nothing here is legal advice, and no policy in this set is compliant merely
because it exists. Where a conclusion needs an attorney it is marked.
