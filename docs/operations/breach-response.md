# Breach response

**Status: statutory basis VERIFIED against primary sources 2026-09-28. Not yet reviewed by
an attorney.** R-07 asks for four things — the runbook, a named decision-maker, pre-drafted
notifications, and one rehearsal. Three are now done: the notifications are in
[`breach-notification-templates.md`](breach-notification-templates.md), the decision-maker
is named in §3, and §0 below replaces a second-hand reading of the statute with the statute.
The rehearsal is §6.

**If you are in an incident right now, start at §2.** Everything before it is context.

---

## 1. The step most templates get wrong

New Jersey's breach statute, **N.J.S.A. 56:8-163**, requires that disclosure to affected
individuals be **preceded by notification to the New Jersey State Police**. Not
simultaneous. Not "also". Before.

That ordering is the entire reason this file exists. Every instinct in an incident pushes
the other way — tell the families first, be transparent, move fast — and acting on that
instinct puts the disclosure out of sequence with the statute. A procedure improvised at
2am will miss it, which is precisely what R-07 predicted.

So the order is fixed, and it is the only thing in this document that is not a judgement
call:

> **Contain → Assess → New Jersey State Police → (Posture A: the district) → affected
> individuals → everyone else.**

**In Posture A there is a tighter clock than the statute.** Student-privacy DPAs commonly
require notice to the district within **24 hours** of discovery — far shorter than any
statutory deadline. If a DPA is signed, read its notification clause before anything else
in this file; it governs, and it starts running at *discovery*, not at confirmation.

> **Read §0 before relying on the paragraph above.** The sequencing is right, and it is
> still the thing most likely to be got wrong at 2am. But the statute only *commands* that
> order for a breach it actually reaches, and whether it reaches a given incident here turns
> on one specific question that §0 sets out. The order remains the house rule either way,
> because notifying the State Police first is never wrong.

---

## 0. Does the statute actually reach us? Read this once, now — not during an incident.

Verified 2026-09-28 against the statute as amended by **P.L. 2019, c.95**, not against a
summary. This section exists because the honest answer is "probably yes, and there is one
real question", and neither half of that can be worked out at 2am.

### What counts as "personal information" — N.J.S.A. 56:8-161

The duty in 56:8-163 is triggered only by a breach of **personal information**, which the
statute defines narrowly: an individual's first name or first initial and last name **linked
with** one or more of:

1. Social Security number;
2. driver's licence or State ID number;
3. account number or credit/debit card number with a security code, access code or password
   permitting access to a financial account;
4. **user name, email address, or any other account holder identifying information, in
   combination with any password or security question and answer.**

**Elements 1 to 3 do not exist in this database at all.** We hold no Social Security
numbers, no government identifiers and no financial account data — which is worth saying in
a notification, because it is the first thing a parent fears.

**Element 4 is the one that reaches us**, and it was added in 2019. The `users` table holds
name, email, username and `password_hash` in the same row. On its face that is exactly the
combination element 4 describes.

> Note what this means for a document written before the 2019 amendment, or from a summary
> of the pre-2019 law: it would have concluded the statute does not apply here, because on
> the pre-2019 text it did not. Date-of-birth, school, grade, private messages, service
> hours and safety reports are **none of them** "personal information" under this statute,
> however sensitive they plainly are. Sensitivity and statutory coverage are different
> things, and only one of them is what 56:8-163 keys on.

### The one question for counsel: does hashing take us back out?

"Breach of security" is defined as unauthorised access to personal information *"when access
to the personal information has not been secured by encryption or by any other method or
technology that renders the personal information unreadable or unusable."*

Passwords here are **bcrypt hashes, never plaintext**. So:

- Element 4 requires the identifier **in combination with a password**. A bcrypt hash is not
  a password and does not permit access to the account.
- There is therefore a serious argument that a dump of the `users` table is not a breach of
  "personal information" at all, and that 56:8-163 — including the State Police step — is
  not triggered.
- There is also a serious argument the other way, because the carve-out is written about the
  *personal information* being unreadable, and name and email in that row are perfectly
  readable.

**This is the single question to put to counsel**, and it is worth the fee because it decides
whether a statutory duty exists at all. It is a narrow, concrete question with a yes/no
answer — not "please review our incident response".

**Until it is answered, assume the duty applies.** Over-notifying is not an offence;
under-notifying is. And the sequence in §1 costs nothing if it turns out not to have been
required.

### Two incident shapes, and they answer differently

Found by the §6 rehearsal, which is the reason this paragraph exists: the `users` table also
carries **`tfa_secret`**, the TOTP seed. A TOTP seed cannot be hashed — verification needs
the secret itself — so unlike a password it is a live credential sitting in the same row as
the name and email. That looked, at first, like it settled the question against us.

It does not, because the seed is **AES-256-GCM encrypted** (`encryptSecret` in
`cryptoUtils.js`) under `TFA_ENCRYPTION_KEY`, **which lives in the host environment and not
in the database**. So the answer depends on what the attacker got:

| Incident | `password_hash` | `tfa_secret` | Where that leaves the carve-out |
|---|---|---|---|
| **Database only** — stolen dump, leaked backup, SQL-injection read | bcrypt, not a password | AES-GCM, key absent | Both credential elements are plausibly "unreadable or unusable". Strongest argument the statute is not triggered. |
| **Host compromise** — the app server and its environment | bcrypt, not a password | **readable: the key is right there** | The carve-out fails for the seed. A live credential is exposed beside name and email. **Treat as triggered.** |

**So the first question in an incident is not "what table" but "did they have the host".**
Record the answer in §2.3 as part of answer 1; it is the fact the whole statutory analysis
turns on, and it is the one that is hardest to reconstruct a week later.

### What the statute does NOT require

- **It prescribes no content for the notice to individuals.** Checked twice against the
  official text. Delivery method and timing are regulated; *what you say* is not. So the
  templates cannot be non-compliant on their wording, which is why they are a drafting
  exercise and not a legal one.
- **Timing is "the most expedient time possible and without unreasonable delay"** — no fixed
  day count, and expressly subject to the legitimate needs of law enforcement.
- **Substitute notice** is only available above thresholds nowhere near us: cost over
  $250,000, or an affected class over 500,000.

### What does not add a duty, despite instinct

- **FERPA carries no breach-notification requirement.** It is a funding condition on
  schools, it says nothing about notifying anyone after a breach, and poor security is not
  itself a FERPA violation. Do not cite it as the reason for notifying.
- **COPPA carries none either.** It requires reasonable security (16 CFR 312.8); it does not
  require breach notice. Its relevance here is the school-consent route for under-13s, which
  is a Phase 0 decision, not an incident-response one.
- **The "compromised email account" rule in 56:8-163 does not apply to us.** It binds an
  entity "that furnishes an email account" — we furnish none; students use school or personal
  addresses. Notifying by email is therefore available. Read that clause again anyway if we
  ever issue addresses.

### What actually binds us first, in Posture A

The **DPA**. A contract with a 24-hour discovery clock is a shorter, harder and more certain
obligation than a statute whose application is arguable — and it binds whether or not
element 4 is met. **Read the DPA's notification clause before this file.**

---

## 2. First thirty minutes

Do these in order. Do not skip ahead to notification; an unscoped incident cannot be
notified accurately, and a wrong notification has to be corrected in public.

### 2.1 Contain

| Situation | Action | How |
|---|---|---|
| An account is compromised | Suspend it | `user.suspend`, from the Admin area |
| A credential leaked | Rotate it | `docs/operations/database-credential-rotation.md` |
| The host is compromised | Stop the service before anything else | `sudo systemctl stop wevolunteer` |
| Data is being exfiltrated now | Take the origin off the internet | Cloudflare: pause the proxy or block at the edge |

**Do not delete anything.** Not logs, not the offending rows, not the attacker's account.
Evidence you destroy while containing is evidence you cannot produce later, and
`report_evidence` exists precisely because deletion during an incident is a known reflex.

### 2.2 Preserve

Before you investigate, take a snapshot you cannot accidentally overwrite:

```bash
sudo systemctl start wevolunteer-backup.service
```

Then copy the resulting archive **off the host**, and write down its filename. The nightly
job prunes at 14 days; an incident can outlast that.

Also preserve, because these rotate or expire:

- `journalctl -u wevolunteer --since "<when it started>" > incident-<date>.log`
- Better Stack logs — 3 days hot, then S3. Export the window *now*, not next week.
- `security_audit_logs` and `admin_audit_logs` — 1 year, but export the relevant window anyway.

### 2.3 Assess — write these five answers down

You cannot notify anybody, or decide whether you must, until you can answer all five. Write
them in a file, timestamped, and keep updating it. This becomes the incident record.

1. **What happened**, in one sentence a non-engineer understands.
2. **When** it started, when it ended, and **when you discovered it** — the discovery
   timestamp starts every clock that matters.
3. **Whose data**, and **how many people**. Count from the database, not from memory.
4. **What data** — names, emails, dates of birth, school, service hours, messages,
   certificates. Be specific; "personal information" is not an answer.
5. **Is it still happening?**

#### The queries for 3 and 4, so nobody writes SQL at 2am

Rehearsed 2026-09-28 against a scratch database. "Count from the database" was an
instruction with no way to follow it; these are that way. Run them against a **restored
snapshot**, never against production during an incident.

```sql
-- Q3. How many people, and how many of them are children.
--     The minor count is the one that decides guardian notification, and it is
--     the number the district will ask for first.
SELECT COUNT(*) AS accounts_total FROM users;

SELECT CASE WHEN grade IN ('Adult','N/A') THEN 'adult/staff' ELSE 'MINOR' END AS who,
       COUNT(*) AS n
FROM users GROUP BY who;

SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY n DESC;
```

```sql
-- Q4. What data. Enumerate the COLUMNS, do not summarise them: the notice has
--     to name fields, and "personal information" is not an answer.
PRAGMA table_info(users);          -- SQLite
-- PostgreSQL:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'users';
```

Reading that column list is itself part of the assessment. On the rehearsal it surfaced
`tfa_secret` and `date_of_birth` — one a credential, the other data about children — neither
of which appears in the informal list at item 4 above. **Trust the column list over any
prose list, including this document's.**

> The rehearsal's own finding: the scratch database answered every one of Q3 and Q4 in under
> a minute once the queries existed, and none of them could be answered from memory. The
> five answers then filled the guardian template in
> [`breach-notification-templates.md`](breach-notification-templates.md) §1 with nothing left
> bracketed except the incident narrative — which is the test that template had to pass.

---

## 3. Notification

> **The decision-maker is: Mahit Pulavarthi, platform owner.**
> Named 2026-09-28 at his own instruction. R-07 asks for a name rather than a role, and it
> now has one: every judgement call in this file — whether to notify, when, and what to say
> — is his to make and his to answer for.
>
> **There is no deputy, and that is the remaining gap.** One name is better than none, but a
> single point of decision is also a single point of failure: an incident found at 3am while
> that person is unreachable has no one authorised to start the clock. Name a second person
> when one exists. Until then, the standing instruction if the decision-maker cannot be
> reached is to **contain and preserve (§2.1, §2.2) and keep notifying up the chain until a
> human answers** — containment never needs authorisation, and the sequence in §1 protects
> the order even when nobody is available to deliberate about it.

### 3.1 New Jersey State Police — FIRST

**Before any disclosure to an affected individual.** New Jersey Cyber Fraud Unit /
NJCCIC — confirm the current reporting channel at the time of the incident rather than
trusting a number written here months earlier.

Have ready: the five answers from §2.3, what you have done to contain it, and your contact
details.

**Record the date, time, method, and who you spoke to.** That record is the evidence you
complied with the sequence.

### 3.2 The district — Posture A only

Within the DPA's window, which is commonly **24 hours from discovery**. Read the clause;
do not assume.

### 3.3 Affected individuals

Only after §3.1. For students under 18 this means **guardians**, through whatever channel
the district's agreement specifies.

Say plainly: what happened, what data, what you have done, what they should do, and who to
contact. Do not minimise, do not speculate about cause, and do not promise a cause before
the investigation finishes.

> **Templates:** [`breach-notification-templates.md`](breach-notification-templates.md)
> — drafted 2026-09-28, so the words are chosen calmly rather than at 2am. Four of them:
> guardian, district, affected adult, and a holding statement, with a pre-send checklist.
>
> **They are not cleared to send.** Notification content for a breach involving New
> Jersey minors is partly prescribed by statute and none of this has been read by
> counsel. R-07 asks for the templates *and* the review; this is the first half.

### 3.4 Everyone else

Only if the scale or the nature warrants it, and only after counsel.

---

## 4. Afterwards

- **Write the postmortem** — what happened, why, what changed. Blameless: the aim is the
  control that was missing, not the person who missed it.
- **File the changes** as ordinary work, with tests, so the fix cannot regress silently.
- **Re-read this document** and correct whatever it got wrong. A runbook that survives an
  incident unchanged was probably not used.

---

## 5. What this platform holds, so scope is fast

An assessment is quicker when you are not discovering the data model during an incident.

| Data | Where | Sensitivity |
|---|---|---|
| Name, email, username, **date of birth**, school, grade | `users` | High — minors |
| Private messages | `messages`, `conversations` | **Highest** — adult↔minor is R-03 |
| Attendance and service hours | `attendance`, `hours_ledger` | Moderate; the record students rely on |
| Certificates, incl. name snapshots that survive deletion | `certificates` | Moderate, and permanent by design |
| Safety and conduct reports | `reports`, `conversation_reports` | **Highest** — a leak here can identify a reporter |
| Admin actions | `admin_audit_logs`, `security_audit_logs` | Evidence — preserve first |

**Backups are encrypted** to a certificate whose private key is not on the host, so a host
compromise yields ciphertext. See `offsite-backups.md`. If the private key is also
believed compromised, say so explicitly in the assessment — it changes the scope from
"the live database" to "every archive".

---

## 6. Rehearsal

**Partly done — 2026-09-28.** Record:
[`breach-rehearsal-2026-09-28.md`](breach-rehearsal-2026-09-28.md).

The assessment half (§2.3) was walked end to end against a scratch database and found three
defects in this document, all now fixed: §2.3 told you to count from the database and gave
you no queries; its prose list of "what data" omitted `tfa_secret` and `date_of_birth`; and
the whole statutory analysis in §0 turns on a host-versus-database distinction that was not
written down anywhere. That is the return on doing it, and it is why the next two bullets
matter rather than being paperwork.

**Still not rehearsed, and these are the expensive halves:**

- **Containment (§2.1).** Never executed. Stopping the service, pausing Cloudflare and
  rotating credentials are untested in anger, and they are the steps under the most time
  pressure.
- **The host snapshot (§2.2).** `wevolunteer-backup.service` was not run for this, and
  getting an archive off the host was not practised.
- **Timing.** Not measured, which R-07 asks for. The assessment took under a minute once
  the queries existed; the untested halves are where the time actually goes.
- **Saying it out loud.** Nobody was called. Explaining an incident to a district
  counterpart is a different skill from writing it down, and it has not been tried.
