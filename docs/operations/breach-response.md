# Breach response

**Status: DRAFT. Not yet rehearsed, not yet reviewed by an attorney.** R-07 asks for
four things — the runbook, a named decision-maker, pre-drafted notifications, and one
rehearsal. This is the first. The other three are marked below and are not engineering.

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

> **Attorney review required.** The statutory reading above is taken from the risk
> register (R-07) and has not been independently verified by counsel. The sequence is
> operationally safe regardless — notifying the State Police first is never wrong — but
> the deadlines, the definition of a reportable breach, and whether a given incident
> qualifies are legal determinations. **This document does not make them.**

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

---

## 3. Notification

> **The decision-maker is: `[[NAMED PERSON]]`.**
> R-07 asks for this to be a name, not a role. Until it is filled in, the platform owner
> decides by default — which is exactly the ambiguity the finding objects to.

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

> **`[[PRE-DRAFTED TEMPLATES]]`** — R-07 asks for these to exist before an incident, so
> they are written calmly rather than at 2am. Not yet drafted. They need the attorney
> review above, because notification content is partly prescribed by statute.

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

**Not yet done.** R-07 asks for one, and a runbook nobody has walked through is a
hypothesis. Walk §2 end to end against the scratch database — contain, snapshot, export
the logs, write the five answers — and time it. Then fix whatever this document got wrong.
