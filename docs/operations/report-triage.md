# Report triage

**Status: DRAFT.** R-10 asks for three things this platform has never written down: **who
looks, how fast, and what gets escalated.** The machinery all exists — queues, priorities,
an urgent broadcast, an audit trail, appeals. What was missing is the commitment about
humans, which no amount of code supplies.

---

## 1. The honest starting point

There is **one** active administrator. Any response time in this document is one person's
commitment, and a schedule that assumes a rota would be fiction.

So the targets in §3 are deliberately modest — targets a single operator can actually meet,
published as such. **A missed promise is worse than a modest one**, particularly on a
safety queue, where the person waiting is a child who reported something frightening.

Revise these upward when there is a second administrator, not before.

---

## 2. The three queues, and which is which

They are genuinely different things and are triaged differently. Knowing which one you are
looking at is the first decision.

| Queue | Table | What arrives | Who can work it |
|---|---|---|---|
| **Conversation reports** | `conversation_reports` | A private message thread reported by a participant. `reason` ∈ `inappropriate`, `spam`, **`safety`**, `other` | `report.resolve` |
| **Content and user reports** | `reports` | Events, comments, messages, users, announcements, certificates. Carries `priority`; `urgent` broadcasts | `report.resolve` |
| **Issue reports** | `issue_reports` | Product problems. Categories include `conduct`, `privacy`, `security`, `legal`. Reporter gets a `reference` | `report.resolve` |

**`conversation_reports` with `reason = 'safety'` is the one that matters most.** It is the
adult↔minor messaging surface R-03 is about. Treat it as safety-first until you have read it
and concluded otherwise — not the reverse.

An `issue_report` in the `conduct`, `privacy` or `security` category is often misfiled and
belongs in one of the other queues, or in the breach runbook. Re-route rather than closing it.

---

## 3. How fast

Measured from the report being filed, not from when you noticed.

| Priority | What it is | Target |
|---|---|---|
| **Safety** | `conversation_reports.reason = 'safety'`, or anything suggesting harm to a minor, from any queue | **Same day. Before anything else, including outages.** |
| **Urgent** | `reports.priority = 'urgent'` — broadcasts `SYSTEM_ALERT` to every moderator as a mandatory notice | **Same day** |
| **Normal** | Conduct, inappropriate content, spam | **3 working days** |
| **Product** | `issue_reports` that are genuinely bugs | Ordinary backlog; no commitment |

> **Published commitment.** The Youth Safety Guidelines currently say safety reports are
> reviewed "as soon as", where the Privacy Policy commits to 10 business days and 45 days.
> **A safety inbox with a vaguer promise than the privacy inbox is the wrong way round.**
> Once the same-day target above has been met for a month, publish it in policy 8 and
> replace the vague phrase. Do not publish it before you have evidence you can keep it.

---

## 4. What to do with one

1. **Read the snapshot, not the live record.** Every queue stores the content as it was when
   reported — `target_body_snapshot`, `reported_name_snapshot`. The live version may have been
   edited or deleted since; the snapshot is what the reporter saw.
2. **Decide the queue**, per §2. Safety-first if uncertain.
3. **If it triggers the reporting duty — stop and go to
   [`mandated-reporter-procedure.md`](mandated-reporter-procedure.md).** Report to the
   hotline *before* acting on the platform: suspending first tells the adult something is
   happening.
4. **Act.** `user.warn`, `user.suspend`, muting (`muted_until`), or content removal. Every
   action writes a `moderation_actions` row with the old and new status, priority, resolution
   and your note — so the reasoning survives you.
5. **Resolve with a note that explains why**, not just what. The appeal in §6 is read by
   somebody who has only your note.

**Never act on a report about yourself, or about somebody you are close to.** With one
administrator there is no one to hand it to, which is itself a reason to record the conflict
in the note and be conservative.

---

## 5. What escalates, and to whom

| Trigger | Goes to | How fast |
|---|---|---|
| Reasonable cause to believe a child has been harmed | **NJ Child Abuse Hotline, 1-877-NJ-ABUSE** | Immediately — see the procedure |
| Immediate danger | **911** | Immediately |
| Personal data exposed to someone who should not have it | [`breach-response.md`](breach-response.md) | Start §2 now |
| Posture A: anything involving a student at the district | The district safeguarding lead | Same day |
| A credible threat of self-harm | **988**, and the district | Immediately |

Escalating is not a failure to handle it. It is the handling.

---

## 6. Appeals

`appeals`, `appeal_tokens` and `appeal_events` exist, and the Community Guidelines promise
suspended people a hearing. The obligation that lands on triage is upstream: **the note you
write when you resolve a report is the entire evidence base of the appeal.** "Resolved" with
no note is an appeal nobody can adjudicate fairly, including you in six months.

---

## 7. Retention

R-10 names a missing retention rule for comments and reports. Those two turn out to be in
opposite positions, and the difference matters.

**Reports are decided, deliberately.** `reports`, `conversation_reports`,
`conversation_report_messages`, `moderation_actions`, `report_evidence` and `appeals` are all
in `PRESERVED_TABLES` in `retentionWorker.js` — a list the sweep asserts it left untouched
after every run, so a future sweep that quietly widened would fail loudly. That matches the
Data Deletion Policy, which keeps safety reports indefinitely by published decision. A safety
report is evidence, and evidence that expires on a timer is evidence somebody can wait out.

**Comments are not decided.** `event_comments` is in neither list: no timer removes it, and
nothing asserts it is protected. It is deleted only as a *cascade* — when the event or the
organizer's shell is purged — so a comment's lifetime is an accident of whose event it sat
under rather than a rule anybody chose. That is the weaker kind of forever.

**Owner decision needed**, and it is narrower than it first looks: not "should reports be
kept" — that is answered — but *should a **dismissed, unfounded** report about a student
persist for ever alongside the founded ones?* The preservation reasoning is about evidence;
an allegation found baseless is a different object, and the current design does not
distinguish them.

---

## 8. Not yet true

- **Nobody is named.** "Who looks" is answered by "the one administrator". Name a person
  and a deputy when one exists.
- **The same-day target is unproven.** Measure before publishing it in policy 8.
- **Retention is undecided.** §7.
- **No admin has accepted the Admin Responsibilities Policy**, which is what should bind
  whoever works these queues. See the launch checklist.
