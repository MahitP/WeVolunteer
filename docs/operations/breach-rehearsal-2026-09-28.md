# Breach rehearsal — 2026-09-28

R-07 asks for one rehearsal. This is the record of it. A runbook nobody has walked
through is a hypothesis, and the point of writing this down is that the next person
can see what was actually tested and what was not.

**Walked by:** Mahit Pulavarthi (platform owner, and the named decision-maker).
**Against:** a throwaway scratch database seeded from the demo fixtures
(`scratch/rehearsal.db`, 15 accounts). **Never production.**

**Scenario:** the `users` table has been exfiltrated. Chosen because it is the most
likely real incident and because it is the one the statutory analysis in
[`breach-response.md`](breach-response.md) §0 turns on.

---

## What was and was not exercised

Being honest about the boundary matters more than the tick.

| §2 step | Exercised? | Why |
|---|---|---|
| 2.1 Contain | **No** | Every action is host-side — `systemctl stop`, Cloudflare, credential rotation. Doing them for practice means taking production down. **Still untested.** |
| 2.2 Preserve | **Partly** | The snapshot command is a host systemd unit, not run here. The *local* half — exporting logs, knowing which tables matter — was walked. **The host half is still untested.** |
| 2.3 Assess | **Yes, fully** | This is the half that feeds every notification, and the half that had no way to follow its own instruction. |
| §3 Notification | **Dry, not sent** | Guardian template filled from the five answers. Nothing sent, no address touched. |

---

## The five answers, as produced

1. **What happened.** A copy of the `users` table was taken. *(Rehearsal: the scenario
   was stipulated rather than investigated — the forensic half is not tested here.)*
2. **When.** Stipulated. **The real finding:** §2.3 asks for discovery time because it
   starts every clock, and in the rehearsal it was the only one of the five that could
   not be answered from the database at all. It has to be written down by a human, the
   moment it happens, or it is lost. *(Now called out in the runbook.)*
3. **Whose data, how many.** Answered by query in seconds:

   | | |
   |---|---|
   | Accounts total | 15 |
   | **Minors** | **6** |
   | Adult / staff | 9 |
   | By role | 12 student, 2 organizer, 1 admin |

   The minor count is the number the district asks for first and the one that decides
   guardian notification. It was not answerable from memory.
4. **What data.** Enumerated by `PRAGMA table_info(users)` — 50 columns.
5. **Still happening?** Stipulated no.

---

## What the rehearsal found

Three things, all now fixed in the runbook. This is the entire return on doing it.

### 1. §2.3 told you to count from the database and gave you no way to

"Count from the database, not from memory" was the instruction, with no queries. At 2am
that means writing SQL against an unfamiliar schema while deciding whether to call the
State Police. The queries are now in §2.3.

### 2. The informal data list in §2.3 was incomplete, and dangerously so

Item 4 lists "names, emails, dates of birth, school, service hours, messages,
certificates". The actual column list surfaced two it does not mention:

- **`tfa_secret`** — the TOTP seed. A credential, not profile data.
- **`date_of_birth`** — data about children, sitting in the same row.

A notification written from the prose list would have omitted a credential. §2.3 now says
to trust the column list over any prose list, **including its own**.

### 3. It changed the statutory analysis — the biggest finding

`tfa_secret` cannot be hashed; TOTP verification needs the secret itself. So at first
glance the `users` table holds a live credential beside a name and email, which would
settle §0 against us.

It does not, because the seed is AES-256-GCM encrypted under `TFA_ENCRYPTION_KEY`, and
**that key is in the host environment, not in the database**. Which produces the
distinction §0 now turns on:

- **Database-only exposure** → both credential elements plausibly "unreadable or
  unusable"; strongest argument the statute is not triggered.
- **Host compromise** → the key is right there; the carve-out fails. **Treat as
  triggered.**

So the first question in an incident is **"did they have the host?"**, not "which table".
That was not in the runbook before this rehearsal and is the fact hardest to reconstruct
a week later.

---

## Did the template actually fill?

The test the guardian template in
[`breach-notification-templates.md`](breach-notification-templates.md) §1 had to pass:
can it be completed from §2.3's five answers alone?

**Yes, with one gap.** Everything resolved from the five answers and the verified
research except:

- `[[GUARDIAN NAME]]` and the delivery channel — which the **district** supplies under
  Posture A, and which we cannot know. Correct as a placeholder.
- The one-sentence narrative — genuinely incident-specific.
- `[[NUMBER]]` in the **district** template — **not incident-specific and not answerable.**
  A district counterpart on a 24-hour clock needs to reach a human by voice, and there is
  no phone number anywhere in this platform's operational documents. **Open.**

The "what was not involved" paragraph, which was a bracketed instruction, is now a
standing sentence of fact: no Social Security numbers, no driver's licence or State ID
numbers, no payment or bank details — verified against the column list, not asserted.

---

## Still untested after this

Written plainly so the tick above is not mistaken for a full drill.

- **Containment (§2.1) has never been executed.** Stopping the service, pausing Cloudflare
  and rotating credentials are all untested in anger.
- **The host snapshot (§2.2).** `wevolunteer-backup.service` was not run for this, and
  copying an archive off the host was not practised.
- **Timing was not measured.** §6 asks for it. The assessment half took under a minute
  once the queries existed; the untested halves are where the time actually goes.
- **Nobody was called.** No State Police contact, no district contact, no rehearsal of
  explaining this out loud — which is a different skill from writing it down.
- **One person walked it**, who is also the only administrator and the only
  decision-maker. A rehearsal cannot test a handover that has nobody to hand over to.
