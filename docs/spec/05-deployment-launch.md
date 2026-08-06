# Volume V — Deployment, Operations and Launch Readiness

**Status:** Normative
**Scope:** Deployment topology, production configuration, monitoring, alerting, logging,
backups, restore drills, scaling, database evolution, the PostgreSQL migration,
infrastructure, operational security, incident response, launch readiness.

**Binds:** Volume I §1.6 (migrations), Volume II §2.5 (secrets), Volume IV §4.14
(maintenance), Appendix C (schema).

---

## 5.1 Purpose and goals

### 5.1.1 Purpose

Specify how the platform runs in production, how its failure is detected, how its data
is protected, and what must be true before it carries real users.

### 5.1.2 Goals

| ID | Goal | Measured by |
|---|---|---|
| G-5.1 | A misconfiguration is caught at boot, not in production behaviour. | INV-020; every guard has a failing-boot test. |
| G-5.2 | Data loss is recoverable, and the recovery is known to work. | A dated restore drill (§5.8.5). |
| G-5.3 | A failure is detected by the system, not by a user report. | §5.5 signals with alert conditions. |
| G-5.4 | One person can operate the platform under time pressure. | Every runbook executable by one operator, verified by execution. |
| G-5.5 | The database engine can change without rewriting the application. | §5.9, and the constraints it places on present work. |
| G-5.6 | Nothing ships to real users that has not passed §5.13. | Launch readiness assessment, evidenced. |

---

## 5.2 Deployment topology

### 5.2.1 Current state

A single Linux host runs one process serving both the API and the built client from the
same origin, backed by a local database file. Service management is by host init units.
There is no container orchestration, no load balancer, and no second instance.

### 5.2.2 Chosen topology

| Component | Placement | Rationale |
|---|---|---|
| Application process | One host, one process | Volume I §1.4.2. |
| Static client | Served by the same process from the same origin | Removes CORS from the client's critical path; permits the cookie protections in Volume II §2.5.3. |
| Database | Local file on the same host | Removes network partition from the failure model. |
| Reverse proxy | Same host, terminating transport security | Certificate management, and a place to serve a static maintenance response when the process is down. |
| Mail | External provider over authenticated submission | Deliverability is not a problem worth solving in-house. |
| Backups | Off-host destination | A backup on the same disk is not a backup. |

### 5.2.3 Requirements on the reverse proxy

| # | Requirement |
|---|---|
| RP-1 | MUST terminate transport security and redirect insecure requests. |
| RP-2 | MUST forward the original scheme and client address so the application's rate limiters key correctly. |
| RP-3 | MUST NOT add, remove or rewrite security headers. The application owns them (Volume II §2.8.1), and a proxy that also sets them produces two sources of truth. |
| RP-4 | MUST serve a static response when the application is unreachable, stating that the platform is temporarily unavailable and that no data has been lost. |
| RP-5 | MUST NOT cache authenticated responses. |
| RP-6 | MUST impose a request body limit at least as large as the application's, never smaller — a smaller proxy limit produces a refusal the application cannot explain. |

**RATIONALE for RP-2.** Without the forwarded address, every request appears to originate
from the proxy, so per-source rate limiting bounds the whole platform to one bucket. This
is a silent failure: limits appear configured and protect nothing.

### 5.2.4 INV-017 — One process per database

**INVARIANT.** Exactly one process may serve one database file.

**Requirements.**

- The process MUST acquire an exclusive lock at startup and MUST refuse to start if it
  cannot, naming the holder.
- The lock MUST be released on graceful shutdown and MUST be reclaimable after an ungraceful
  one without manual intervention.
- The refusal MUST be unambiguous. A second instance starting silently is the failure this
  prevents.

**RATIONALE.** The database is an embedded file. Two writers produce lock contention,
partial writes and — with the write-ahead journal — corruption states that are not
detectable until read. The invariant is also the reason horizontal scaling requires the
engine change in §5.9.

### 5.2.5 Deployment procedure

| # | Step | Requirement |
|---|---|---|
| DP-1 | Take a backup and verify it restores | MUST precede any deployment carrying a migration. |
| DP-2 | Build the client | MUST be built from the release commit, not copied from a prior build. |
| DP-3 | Install dependencies from the lockfile | Root only (Volume I §1.3.3). |
| DP-4 | Stop the process gracefully | §5.2.6. |
| DP-5 | Replace the artefact | |
| DP-6 | Start the process | Migrations run at startup; boot guards apply. |
| DP-7 | Verify | §5.2.7. |
| DP-8 | Record | Version, time, operator, and what was verified. |

**Requirement.** A deployment MUST NOT proceed past DP-6 if boot fails. A failed boot MUST
leave the prior artefact restorable, and the rollback MUST be a documented single
operation.

### 5.2.6 Graceful shutdown

**Requirements.**

| # | Requirement |
|---|---|
| GS-1 | Stop accepting new connections. |
| GS-2 | Allow in-flight requests to complete, up to a bounded period. |
| GS-3 | Drain every background worker and scheduler. |
| GS-4 | Close the realtime transport, permitting clients to reconnect on restart. |
| GS-5 | Close the database **last**. |
| GS-6 | Release the instance lock. |
| GS-7 | Exit with a status distinguishing graceful from forced. |

**Requirement.** GS-3 MUST precede GS-5. A worker writing after the database is closed
produces an unhandled failure and, worse, loses the work silently.

**Requirement.** The bounded period in GS-2 MUST be shorter than the service manager's
kill timeout, so a graceful shutdown completes rather than being killed mid-drain.

### 5.2.7 Post-deployment verification

Every item MUST be executed. Absence of an error is not verification.

| # | Check | Evidence |
|---|---|---|
| PV-1 | Health endpoint reports healthy and the expected version | Response body |
| PV-2 | Migrations applied and checksums verified | Boot log |
| PV-3 | Legal hashes verified; every published document answers | Boot log plus per-document status |
| PV-4 | Sign-in succeeds end to end | Manual or scripted |
| PV-5 | A representative authenticated read succeeds | |
| PV-6 | Provider advertisement matches configuration | Provider endpoint response |
| PV-7 | Mail send succeeds | A test notice to the operator's own account |
| PV-8 | Schedulers are running | Developer Mode Scheduler Inspector |
| PV-9 | No new diagnostic events of a class absent before | Diagnostic surface |
| PV-10 | Instance lock held by exactly one process | |

### 5.2.8 Acceptance criteria for §5.2

| # | Criterion |
|---|---|
| AC-5.2.1 | A second instance refuses to start and names the holder. |
| AC-5.2.2 | The lock is reclaimable after an ungraceful exit. |
| AC-5.2.3 | The proxy forwards scheme and client address; rate limiting keys correctly. |
| AC-5.2.4 | The proxy sets no security header. |
| AC-5.2.5 | A static unavailable response is served when the process is down. |
| AC-5.2.6 | Shutdown drains workers before closing the database. |
| AC-5.2.7 | The drain bound is shorter than the kill timeout. |
| AC-5.2.8 | Every post-deployment check has recorded evidence for the current release. |

---

## 5.3 Production configuration

### 5.3.1 Purpose

Ensure the platform cannot run in an unsafe configuration.

### 5.3.2 INV-020 — Boot fails closed

**INVARIANT.** Production boot MUST fail on any of the following. Each failure MUST name
the variable, the reason, and the remedy.

| # | Condition | Reason |
|---|---|---|
| BG-1 | Signing secret absent, a recognised placeholder, or below minimum strength | Volume II §2.5.2. Every session is signed with it; a guessable value permits minting a token for any account. |
| BG-2 | Mail configuration incomplete | Mandatory notices cannot be delivered. A suspension without its notice is a lockout with no reason given and no appeal path (Volume III §3.6.5). |
| BG-3 | Application URL absent | Every action link in every notice is unconstructable. |
| BG-4 | Demonstration mode enabled in production | Demonstration credentials are published in the interface. |
| BG-5 | Runtime version outside the pinned range | The embedded database interface differs across majors; failing later produces an unrelated error. |
| BG-6 | Migration checksum mismatch | An applied migration's source has changed; the schema's provenance is unknown. |
| BG-7 | Legal document hash mismatch | Volume I §1.6.7. An acceptance record referencing changed text is not evidence. |
| BG-8 | A configured provider with a loopback redirect target | The callback cannot reach a production deployment; every sign-in through it fails after leaving the site. |
| BG-9 | Database not writable | Every write path fails; failing at boot is honest. |

**Requirement.** A failure message MUST include the remedy, including a generation command
where one applies. A message naming only the problem forces the operator to search for the
fix during an outage.

**Requirement.** Each guard MUST have a test that boots a process and asserts the exit
status **and** the message.

### 5.3.3 Development configuration

**Requirements.**

- Development MAY relax BG-1 through BG-4, and MUST warn loudly on every boot when it
  does.
- Development MUST NOT relax BG-5 through BG-9. A schema whose provenance is unknown and a
  legal document whose hash has moved are equally serious anywhere.
- Demonstration mode MUST be enabled only by the development entry point, never by a
  default.
- Authorization MUST NOT vary by environment (Volume IV §4.5.4 DM-7).

### 5.3.4 Compiled configuration

**Requirement.** Values compiled into the client bundle MUST be documented as requiring a
rebuild. Setting one on a running server has no effect.

**FAILURE MODE.** An operator changes a compiled value, restarts, observes no change, and
concludes the setting does not work — then changes something else that does have an
effect, producing a configuration nobody intended.

### 5.3.5 Configuration inventory obligation

**Requirement.** Every configuration variable MUST appear in the example file with a
description, whether it is required, its default, and whether it is compiled. A test MUST
fail when a variable read by the application is absent from the example file.

**RATIONALE.** An undocumented variable is discovered by reading source during an
incident.

### 5.3.6 Acceptance criteria for §5.3

| # | Criterion |
|---|---|
| AC-5.3.1 | Each of BG-1 to BG-9 fails boot in production, asserted by exit status and message. |
| AC-5.3.2 | Every failure message contains a remedy. |
| AC-5.3.3 | Development relaxations are limited to BG-1 to BG-4 and warn on every boot. |
| AC-5.3.4 | Demonstration mode cannot be enabled by default. |
| AC-5.3.5 | Every read variable appears in the example file; a missing one fails a test. |
| AC-5.3.6 | Compiled values are marked as requiring a rebuild. |

---

## 5.4 Logging

### 5.4.1 Requirements

| # | Requirement |
|---|---|
| LG-1 | Logs MUST be structured, with a level, a timestamp and a subsystem. |
| LG-2 | Logs MUST NOT contain credentials, tokens, secrets, grant values, message bodies, evidence content, or unredacted personal data. |
| LG-3 | A log line MUST NOT be the only record of an administrative act. Logs are swept and are not a trail. |
| LG-4 | An error log MUST include enough context to locate the request without including its body. |
| LG-5 | Log volume MUST be bounded. A per-request access log at full verbosity fills the disk, and a full disk stops the database. |
| LG-6 | Rotation and retention MUST be configured at the host, and the retention MUST be stated. |
| LG-7 | A subsystem MUST be identifiable in every line it writes, so a noisy subsystem can be isolated. |

**RATIONALE for LG-5.** Disk exhaustion on a single-host deployment with a local database
is a data-availability incident, and logging is its most common cause.

### 5.4.2 Distinction from diagnostics

| | Logs | Diagnostic events |
|---|---|---|
| Audience | Operator, during and after an incident | Developer, triaging defects |
| Retention | Short, host-managed | Bounded window, application-managed |
| Content | Operational facts | Redacted failure records with grouping |
| Personal data | None | Hashed subject only |
| Queryable | By text | By fingerprint, status, source, route |

**Requirement.** Neither substitutes for the other, and neither substitutes for the audit
trails.

### 5.4.3 Acceptance criteria for §5.4

| # | Criterion |
|---|---|
| AC-5.4.1 | No log line contains any item in LG-2, asserted by scanning a produced log under exercise. |
| AC-5.4.2 | Rotation and retention are configured and stated. |
| AC-5.4.3 | Every line carries level, timestamp and subsystem. |
| AC-5.4.4 | Log growth under load is measured and bounded. |

---

## 5.5 Monitoring and alerting

### 5.5.1 Purpose

Detect failure before a user reports it, and page only for what requires a person.

### 5.5.2 Health endpoint

**Requirements.**

| # | Requirement |
|---|---|
| HE-1 | Unauthenticated, cheap, and MUST NOT be rate-limited into unavailability. |
| HE-2 | MUST report: overall state, database connectivity, database writability, and version. |
| HE-3 | MUST report maintenance state **distinctly** from unhealthy (Volume IV §4.14 MM-3). |
| HE-4 | MUST NOT disclose configuration values, paths, counts of users, or dependency versions. |
| HE-5 | MUST report the version from the workspace manifest, and a test MUST assert both manifests agree. |
| HE-6 | MUST answer during maintenance. |

**RATIONALE for HE-2's writability check.** A read-only database answers connectivity
checks successfully while every write fails. Connectivity alone is not health.

### 5.5.3 Signals and alert conditions

| # | Signal | Condition | Severity |
|---|---|---|---|
| S-01 | Process liveness | Not serving | **Page** |
| S-02 | Health endpoint state | Unhealthy | **Page** |
| S-03 | Database writability | False | **Page** |
| S-04 | Disk free | Below threshold | **Page** |
| S-05 | Instance lock | Held by more than one, or by none while serving | **Page** |
| S-06 | Audit write failure | Any occurrence | **Page** — acts are occurring unrecorded |
| S-07 | Mandatory notice enqueue failure | Any occurrence | **Page** — a suspension may be uncommunicated |
| S-08 | Break-glass use | Any occurrence | **Page** |
| S-09 | Backup age | Exceeds interval | **Page** |
| S-10 | Certificate expiry | Within threshold | Alert |
| S-11 | Notification queue depth | Sustained growth | Alert |
| S-12 | Notification queue oldest item age | Exceeds threshold | Alert |
| S-13 | Scheduler last-run age | Exceeds interval plus margin | Alert |
| S-14 | Diagnostic event rate | Step change | Alert |
| S-15 | New diagnostic group | First occurrence of a crash class | Alert |
| S-16 | Failed sign-in rate, platform-wide | Step change | Alert |
| S-17 | Refusal rate by capability | Step change | Alert |
| S-18 | Provider callback failure rate | Any sustained failure | Alert |
| S-19 | Urgent report unactioned age | Exceeds the published response commitment | **Page** |
| S-20 | Owner count | Not two | Alert |
| S-21 | Maintenance overrun | Past stated duration | Alert |
| S-22 | Frozen account age | Past bound | Alert |
| S-23 | Request duration at the 95th percentile | Exceeds budget | Alert |
| S-24 | Migration checksum status | Mismatch | **Page** |

**Requirement on S-19.** The published commitment is a promise to a child. A report
exceeding it MUST page, because on a one-operator platform the only thing between that
promise and an unread queue is a notification.

**Requirement.** Every page MUST correspond to a documented response procedure. A page
with no procedure trains the operator to acknowledge and defer.

**Requirement.** Alerting MUST be deliverable to a channel the operator receives when away
from a machine, and the delivery path MUST be tested on a schedule.
**RATIONALE:** an alerting system whose delivery has never been tested is a monitoring
system that has never alerted.

### 5.5.4 Alert hygiene

| # | Requirement |
|---|---|
| AH-1 | An alert firing without a person acting MUST be reviewed: either the threshold is wrong or the response is missing. |
| AH-2 | A recurring alert with a known benign cause MUST be fixed or suppressed with a recorded reason and an expiry. |
| AH-3 | Suppressions MUST expire. An indefinite suppression is a deleted alert. |
| AH-4 | The alert inventory MUST be reviewed on the same schedule as the owner-count review. |

### 5.5.5 Acceptance criteria for §5.5

| # | Criterion |
|---|---|
| AC-5.5.1 | Health reports writability, not only connectivity. |
| AC-5.5.2 | Health discloses nothing in HE-4. |
| AC-5.5.3 | Both manifests agree on version; asserted by test. |
| AC-5.5.4 | Every page-severity signal has a documented procedure. |
| AC-5.5.5 | Alert delivery has a dated test. |
| AC-5.5.6 | Every suppression has a reason and an expiry. |

---

## 5.6 Background work in production

### 5.6.1 Requirements

| # | Requirement |
|---|---|
| BW-1 | Every worker and scheduler MUST be observable: last run, outcome, duration, item count (Volume IV §4.5.5.1). |
| BW-2 | A failure MUST NOT terminate the process and MUST NOT stop future scheduling. |
| BW-3 | Consecutive failures MUST be counted and MUST alert. |
| BW-4 | A worker MUST NOT hold a transaction across an await boundary. |
| BW-5 | A sweep that deletes MUST assert inside its transaction (Volume I §1.4.8). |
| BW-6 | Work MUST be idempotent, because a restart mid-run re-executes it. |
| BW-7 | A schedule MUST include a grace period after its trigger condition, so a brief outage does not skip an occurrence. |

### 5.6.2 The retention sweep

**Requirements.**

| # | Requirement |
|---|---|
| RS-1 | Every retention period MUST match the published policy exactly. |
| RS-2 | Exemptions MUST be **derived from the schema**, never enumerated. |
| RS-3 | Safety assertions MUST run inside the deleting transaction. |
| RS-4 | A dry-run mode MUST exist and MUST report the same set the real sweep would remove. |
| RS-5 | The sweep MUST NOT cascade into another person's records. |
| RS-6 | The sweep MUST NOT trip an immutability constraint (Volume II §2.9.8). |
| RS-7 | Each pass MUST record what it removed, by class and count. |

**RATIONALE for RS-2, restating a realised failure.** An organizer's anonymised shell was
never exempt from purging however many students' service records hung off their events,
because the exemption checked only the purged account's own attendance rows — and the
attendance subject is always the volunteer, never the organizer. The defect was
time-armed: nothing purges until years after a deletion, so it had to be found by reading
the schema rather than by waiting for it.

**RATIONALE for RS-4.** A dry run reporting a different set from the real sweep is worse
than no dry run, because it is relied upon.

### 5.6.3 The suspension normalisation sweep

**Status.** Not wired to a schedule. Volume III §3.8.5 specifies why access correctness
does not depend on it.

**Requirements when built.**

| # | Requirement |
|---|---|
| SN-1 | MUST use the same predicate as the enforcement points (INV-013). |
| SN-2 | MUST record what it lifted. |
| SN-3 | MUST NOT increment token versions. |
| SN-4 | MUST tolerate an unreadable deadline by leaving the record alone, consistent with failing closed. |
| SN-5 | Until wired, its absence MUST be stated in the launch readiness assessment rather than implied. |

### 5.6.4 Worker isolation

**Requirement.** A worker's failure MUST NOT affect another worker or the request path. A
worker MUST NOT share a mutable module-level structure with a request handler without
explicit synchronisation.

### 5.6.5 Acceptance criteria for §5.6

| # | Criterion |
|---|---|
| AC-5.6.1 | Every worker's state is observable. |
| AC-5.6.2 | A failure neither terminates the process nor stops scheduling. |
| AC-5.6.3 | Consecutive failures alert. |
| AC-5.6.4 | Retention periods match the published policy, asserted per class. |
| AC-5.6.5 | Exemptions are schema-derived; a new child table is covered without a code change. |
| AC-5.6.6 | The dry run reports the same set as the sweep. |
| AC-5.6.7 | The sweep does not trip an immutability constraint. |
| AC-5.6.8 | The normalisation sweep's absence is stated, or it is wired with SN-1 to SN-4. |

---

## 5.7 Scaling

### 5.7.1 Current ceiling

| Dimension | Ceiling | Binding constraint |
|---|---|---|
| Concurrent writers | One process | INV-017 |
| Concurrent readers | Bounded by the process's event loop | Single process |
| Database size | Bounded by disk and by acceptable backup duration | Local file |
| Realtime connections | Bounded by process memory and file descriptors | Single process |
| Deployment availability | Restart is downtime | No second instance |

### 5.7.2 Vertical scaling first

**Requirement.** Capacity MUST be increased vertically until a measured limit is reached.
The measurement MUST be recorded.

**RATIONALE.** The deployment serves one school. Horizontal scaling requires the engine
change in §5.9, which is a substantial project with its own risks. Undertaking it before a
measured need is speculative work whose cost is certain and whose benefit is not.

### 5.7.3 Scaling triggers

Each is a **measured** condition that justifies the next architectural step.

| # | Trigger | Next step |
|---|---|---|
| SC-1 | Request duration at the 95th percentile exceeding budget under normal load, with the cause identified as contention rather than a slow query | Engine change (§5.9) |
| SC-2 | Backup duration exceeding the acceptable window | Engine change, or archival partitioning |
| SC-3 | Restart downtime becoming unacceptable to the institution | Second instance, therefore engine change |
| SC-4 | A second tenant with an isolation requirement the shared process cannot meet | Engine change plus Volume IV §4.12 |
| SC-5 | Realtime connections approaching process limits | Separate transport process |

**Requirement.** A trigger MUST be evidenced by measurement before the step is taken. An
anticipated trigger is not a trigger.

### 5.7.4 What MUST NOT be done to defer scaling

| # | Prohibited | Reason |
|---|---|---|
| SP-1 | Running a second instance against the same file | INV-017. Corruption, not contention. |
| SP-2 | Caching authenticated responses at the proxy | Cross-user disclosure. |
| SP-3 | Removing the instance lock | Removes the detection of SP-1. |
| SP-4 | Denormalising a derived figure into a counter | INV-001, INV-025. |
| SP-5 | Reducing password verification cost | Volume II §2.15. |
| SP-6 | Disabling audit writes under load | Volume II §2.9. |

### 5.7.5 Acceptance criteria for §5.7

| # | Criterion |
|---|---|
| AC-5.7.1 | The current ceiling is measured and recorded, not estimated. |
| AC-5.7.2 | Every trigger has a defined measurement. |
| AC-5.7.3 | No prohibited deferral is present. |

---

## 5.8 Backups, restore and drills

### 5.8.1 Purpose

Make data loss survivable, and know that it is.

### 5.8.2 Backup requirements

| # | Requirement |
|---|---|
| BK-1 | Backups MUST be taken on a schedule, and the interval MUST be stated. |
| BK-2 | A backup MUST be a consistent snapshot, taken in a manner safe for a live database with a write-ahead journal. Copying the file alone MUST NOT be the mechanism. |
| BK-3 | A backup MUST be written to a destination **off the host**. |
| BK-4 | A backup MUST be verified for integrity immediately after creation, and a failed verification MUST alert. |
| BK-5 | Retention MUST include multiple generations, so that a corruption discovered late is still recoverable. |
| BK-6 | A backup MUST be taken and verified before any deployment carrying a migration (DP-1). |
| BK-7 | Backup age MUST be a monitored signal (S-09). |
| BK-8 | A backup MUST be encrypted at rest if the destination is not exclusively controlled. |
| BK-9 | The backup contains private messages, evidence and disciplinary records. Access to the destination MUST be treated as equivalent to database access, and MUST be enumerated in the operational security review (§5.11). |

**RATIONALE for BK-2.** A naïve file copy of a database with a live write-ahead journal
can produce a file that opens successfully and is missing recent committed transactions —
a backup that appears valid and silently is not.

**RATIONALE for BK-5.** A single generation plus a corruption that predates it leaves
nothing. Corruption is frequently discovered days after it occurs.

### 5.8.3 Retention policy alignment

**Requirement.** Backup retention MUST be reconciled with the published data-retention
policy. Where a person's data has been purged from the live database, backups older than
the purge still contain it.

**Requirement.** This MUST be disclosed in the privacy policy, with the backup retention
period stated. An undisclosed copy is a policy that is false.

**Requirement.** Backup retention MUST NOT exceed what is operationally necessary, because
every additional generation extends the window in which purged data still exists.

### 5.8.4 Restore requirements

| # | Requirement |
|---|---|
| RE-1 | The procedure MUST be a runbook executable by one operator with no other reference. |
| RE-2 | It MUST state how to identify the correct generation. |
| RE-3 | It MUST include verification: schema present, migration state consistent, checksums verify, legal hashes verify, row counts plausible, and a successful sign-in. |
| RE-4 | It MUST state what is lost — the interval between the backup and the failure — and how to determine it. |
| RE-5 | It MUST be performable into a **separate** location first, so a restore attempt cannot destroy the current state. |
| RE-6 | It MUST state the expected duration. |

### 5.8.5 INV — Restore drills

**Requirement.** The restore procedure MUST have been executed against a real backup, into
a scratch location, with the verification in RE-3 performed. The execution MUST be dated
and recorded.

**Requirement.** A drill MUST be repeated after any schema rebuild, and on a stated
schedule.

**RATIONALE.** A backup that has never been restored is not a backup; it is a file whose
usefulness is an assumption. The assumption fails at the worst moment. This is the single
most frequently deferred operational obligation and the one whose deferral is least
defensible: it costs an hour and it converts a hypothesis into a fact.

**Requirement.** Two schema rebuilds have shipped (Appendix C). A drill MUST be performed
before launch, and the launch readiness assessment MUST NOT pass without it (§5.13).

### 5.8.6 Acceptance criteria for §5.8

| # | Criterion |
|---|---|
| AC-5.8.1 | Backups are scheduled, journal-safe, off-host, and integrity-verified. |
| AC-5.8.2 | Multiple generations are retained. |
| AC-5.8.3 | Backup age alerts. |
| AC-5.8.4 | Destination access is enumerated in the security review. |
| AC-5.8.5 | Backup retention is disclosed in the privacy policy with its period. |
| AC-5.8.6 | The restore runbook meets RE-1 to RE-6. |
| AC-5.8.7 | A dated drill exists, performed after the most recent rebuild. |

---

## 5.9 Database evolution and the PostgreSQL migration

### 5.9.1 Purpose

Specify the engine change, the constraints it places on present work, and the conditions
under which it is undertaken.

### 5.9.2 Measured current state

| Fact | Measurement |
|---|---|
| Driver | Embedded, synchronous, local file |
| Files containing SQL | 64 |
| Files importing the database module | 27 |
| Pragma statements | 109 |
| Versioned migrations | 18 |
| Destructive rebuilds | 2 |
| Immutability triggers | 16 |
| Process model | Exactly one (INV-017) |
| Background workers | 3, in-process |
| Schedulers | 1, in-process |
| Realtime | In-process transport |

### 5.9.3 The blocking property

**The migration is a synchrony change, not a dialect change.**

The embedded interface is **synchronous**. Every one of the 64 SQL-bearing files calls it
synchronously, and every transaction boundary depends on synchronous execution: a
transaction is opened, statements run, and it commits, with no possibility of an
interleaved await.

A network database is asynchronous. Converting means every call site becomes asynchronous,
which means every function containing one becomes asynchronous, which propagates to every
caller. And the transaction guarantees change character: an await inside a transaction
becomes possible, which is exactly the hazard Volume I §1.7.4 prohibits and which the
current interface made structurally impossible.

**Requirement.** The migration MUST NOT be attempted incrementally by converting some call
sites. A partially converted system has two transaction models, and the boundary between
them is where correctness is lost.

### 5.9.4 Other blockers

| # | Blocker | Detail |
|---|---|---|
| BL-1 | Migration registry is dialect-specific | 18 migrations written against embedded semantics, checksum-verified. Two are rebuilds that exist **only** because the engine cannot alter a constraint in place; in a network engine each becomes two or three statements and the six guards become moot. They cannot be replayed. A port needs a single generated baseline with the migration record restarted and the checksum system rebuilt around it. |
| BL-2 | Pragmas do not port | 109 statements. Journal mode, foreign-key enforcement, synchronous mode and the rest have no equivalents; the guard that asserts a pragma took effect (Volume I §1.6.4 guard 2) is meaningless outside the embedded engine. |
| BL-3 | Immutability triggers must be rewritten | 16 triggers, in a different trigger language, with different abort semantics. Each MUST be re-verified individually, because these enforce INV-010 and the appeal write-once rules. |
| BL-4 | Partial expression index | One constraint (Appendix C) is a partial unique index over an expression. The target engine supports both, so it ports — but a naïve table translation drops it, and dropping it permits duplicate administrator conversations (Volume III §3.1.4). |
| BL-5 | Background work has nowhere to run in a serverless model | Three workers and a scheduler run for the process's life. A function-per-request platform has no such lifetime. |
| BL-6 | Realtime transport requires a persistent connection | Incompatible with a function-per-request model. |
| BL-7 | Single-instance assumptions become false | The instance lock, and every place that assumes one writer. |
| BL-8 | Local filesystem for exports | An export written to local disk is unreachable from a second instance. |
| BL-9 | Authentication is the platform's own | It MUST remain so. Adopting a managed identity provider would move the capability model outside this specification's control. |
| BL-10 | Boot guards assume a process | A function model has no boot; the guards would need a different enforcement point. |

### 5.9.5 Options

| Option | Description | Assessment |
|---|---|---|
| **A** | Managed Postgres, application on a long-lived host | Preserves workers, scheduler, realtime and boot guards. Requires the synchrony conversion. Enables a second instance, therefore removes restart downtime. **The recommended target when a trigger in §5.7.3 fires.** |
| **B** | Managed Postgres, application as functions | Requires the synchrony conversion **plus** relocating workers, scheduler and realtime, **plus** a new enforcement point for boot guards. Rejected: the cost is the whole of A plus a rearchitecture, for a deployment serving one institution. |
| **C** | Remain on the embedded engine, one host | Zero migration cost. Retains every current ceiling (§5.7.1). **The recommended posture until a trigger fires.** |

**Recommendation.** Launch on option C. Move the **client** to a static host whenever
convenient — it is a built bundle, and only the API origin and the origin allowlist need
setting. Treat the backend engine change as its own project, undertaken when a §5.7.3
trigger is measured.

### 5.9.6 Constraints on present work

These bind every change made **before** the migration, so that the migration does not
become harder.

| # | Constraint |
|---|---|
| CP-1 | A new query MUST be expressible in standard SQL where practical. An engine-specific construct MUST be noted in the module. |
| CP-2 | A new pragma MUST be justified and noted as non-portable. |
| CP-3 | A new immutability trigger MUST be recorded in Appendix C with its intent, so it can be re-expressed rather than reverse-engineered. |
| CP-4 | A new constraint that a naïve translation would drop MUST be flagged in Appendix C. |
| CP-5 | A new destructive rebuild MUST be avoided where an additive path exists, because each one is work that the target engine would not have required. |
| CP-6 | New background work MUST be added to the workers already draining at shutdown, not as a new lifetime assumption. |
| CP-7 | A new filesystem dependency MUST be avoided. |
| CP-8 | A transaction MUST NOT span an await, so the conversion does not have to fix existing violations while creating the possibility of new ones. |

### 5.9.7 Migration procedure, when undertaken

| # | Phase |
|---|---|
| MP-1 | Generate a baseline schema from the current one, by inspection, and review it against Appendix C table by table. |
| MP-2 | Re-express all 16 triggers and verify each individually against the invariant it enforces. |
| MP-3 | Re-express the partial expression index and verify duplicate prevention behaviourally. |
| MP-4 | Convert the data-access layer to asynchronous, wholesale, with the transaction helper enforcing the no-await rule. |
| MP-5 | Convert all 64 SQL-bearing files, in one change, gated on the full suite. |
| MP-6 | Restart the migration record at the baseline; rebuild the checksum system. |
| MP-7 | Re-derive every boot guard for the new engine. |
| MP-8 | Migrate data with row-count parity per table and child-count parity per relationship. |
| MP-9 | Run the ledger/derivation parity check (INV-001) and the materialisation parity check (INV-025). |
| MP-10 | Verify every invariant in §0.7 against the new engine, individually. |
| MP-11 | Perform a restore drill on the new engine before it carries real users. |

**Requirement.** MP-5 MUST be one change. See §5.9.3.

**Requirement.** The old system MUST remain restorable throughout, and the cutover MUST
have a rehearsed rollback.

### 5.9.8 Acceptance criteria for §5.9

| # | Criterion |
|---|---|
| AC-5.9.1 | The measurements in §5.9.2 are re-taken and current. |
| AC-5.9.2 | Every constraint CP-1 to CP-8 is observed by changes made since this document. |
| AC-5.9.3 | Appendix C flags every non-portable construct and every constraint a naïve translation would drop. |
| AC-5.9.4 | No transaction spans an await, asserted by review. |
| AC-5.9.5 | The recommendation is recorded in the launch readiness assessment. |

---

## 5.10 Infrastructure

### 5.10.1 Requirements

| # | Requirement |
|---|---|
| IN-1 | The host MUST be provisioned by a recorded, repeatable procedure. A hand-configured host cannot be rebuilt under pressure. |
| IN-2 | The application MUST run as an unprivileged account with no interactive shell. |
| IN-3 | The database file and the export directory MUST be readable only by that account. |
| IN-4 | Secrets MUST be provided by a mechanism not readable by other host accounts, and MUST NOT appear in process arguments. |
| IN-5 | The service MUST restart automatically on failure, with a backoff that prevents a crash loop from exhausting resources. |
| IN-6 | Automatic restart MUST NOT mask a boot guard failure: a guard failure MUST NOT be retried indefinitely, because the platform would appear to be flapping rather than misconfigured. |
| IN-7 | Host firewall MUST expose only the proxy's ports. The application port MUST NOT be reachable externally. |
| IN-8 | Unattended security updates MUST be enabled for the operating system, and MUST NOT be enabled for the runtime, because a runtime major change violates BG-5. |
| IN-9 | Time MUST be synchronised. Every timestamp, deadline and expiry depends on it. |
| IN-10 | Disk usage MUST be monitored (S-04) with headroom sufficient for the database, its journal, backups in progress, and logs. |

**RATIONALE for IN-6.** A crash loop from a misconfiguration presents as intermittent
availability, which is diagnosed as a load or network problem. Failing fast and staying
down presents as a configuration problem, which is what it is.

**RATIONALE for IN-9.** A host with drifting time produces suspensions that expire early
or late, step-up grants that expire unpredictably, and audit timestamps that cannot be
ordered against external records.

### 5.10.2 Acceptance criteria for §5.10

| # | Criterion |
|---|---|
| AC-5.10.1 | Provisioning is recorded and repeatable; a rebuild has been performed at least once. |
| AC-5.10.2 | The application account is unprivileged with no shell. |
| AC-5.10.3 | Data files are readable only by that account. |
| AC-5.10.4 | Secrets are not in process arguments. |
| AC-5.10.5 | Restart backoff exists; a boot guard failure does not loop indefinitely. |
| AC-5.10.6 | The application port is not externally reachable. |
| AC-5.10.7 | Runtime updates are not unattended. |
| AC-5.10.8 | Time synchronisation is active. |

---

## 5.11 Operational security

### 5.11.1 Access enumeration

**Requirement.** The following MUST be enumerated, with who holds each, reviewed on the
same schedule as the owner-count review.

| # | Access | Equivalent to |
|---|---|---|
| OS-1 | Host shell | Total control, including break-glass |
| OS-2 | Backup destination | Full database read: private messages, evidence, disciplinary records |
| OS-3 | Mail provider | Ability to read notices and to send as the platform |
| OS-4 | Identity provider console | Ability to alter the owner's sign-in path |
| OS-5 | Repository write | Ability to introduce code into a release |
| OS-6 | Domain registrar and DNS | Ability to redirect the platform |
| OS-7 | Certificate issuance | Ability to intercept transport |
| OS-8 | Owner account credentials | Volume II §2.10.6 |

**RATIONALE for enumerating OS-2 explicitly.** Backup destination access is routinely
treated as an operational detail. It is a full read of every private message and every
disciplinary record on a platform for minors. It is equivalent to database access and MUST
be governed as such.

### 5.11.2 Requirements

| # | Requirement |
|---|---|
| OSR-1 | Every access above MUST be held by the smallest number of people, and MUST be individually attributable. Shared credentials MUST NOT be used for any of them. |
| OSR-2 | Multi-factor authentication MUST be enabled wherever the provider supports it. |
| OSR-3 | Revocation MUST be a documented procedure for each, executable without the departing party's cooperation. |
| OSR-4 | The enumeration MUST be reviewed quarterly and the review recorded. |
| OSR-5 | No access above may be granted to a coding agent, a build system, or any automated process beyond what its function requires, and each such grant MUST be enumerated. |

### 5.11.3 Dependency and advisory handling

**Requirement.** An advisory MUST be **assessed for applicability** before action (Volume I
§1.2.7). The assessment MUST record: the advisory, the affected package and version,
whether the vulnerable code path is reachable in this configuration, the evidence for that
determination, the available remedies, and the decision with its reasoning.

**Requirement.** Downgrading to clear an inapplicable advisory is prohibited: it exchanges
a theoretical risk for a real behaviour change.

**Requirement.** An assessment MUST be re-taken each release, because reachability changes
when the application changes.

**Worked example, recorded as current.** Two high-severity advisories are open against the
routing library at its newest published version in the current major, so no patched
release exists. The advisory concerns a server-rendering mode. The application is a
client-only single-page application, imports no server-side routing interface anywhere,
and the server deliberately never loads the library. The vulnerable path is unreachable.
The only offered remedy is a breaking downgrade. **Decision: do not downgrade; watch for a
patched release in the current major; re-assess if server rendering is ever adopted.**

### 5.11.4 Secret rotation

| # | Requirement |
|---|---|
| SR-1 | Every secret MUST have a documented rotation procedure. |
| SR-2 | Signing-secret rotation ends every session; the procedure MUST include announcing the forced sign-out, because otherwise every user experiences an unexplained sign-out and a portion conclude the platform is broken. |
| SR-3 | Provider credential rotation MUST be performable without downtime by configuring the new value before revoking the old. |
| SR-4 | Mail credential rotation MUST be verified by a successful send before the old value is revoked. |
| SR-5 | Every rotation MUST be recorded. |

### 5.11.5 Acceptance criteria for §5.11

| # | Criterion |
|---|---|
| AC-5.11.1 | Every access in §5.11.1 is enumerated with holders. |
| AC-5.11.2 | No shared credential is used for any of them. |
| AC-5.11.3 | Revocation procedures exist and do not require cooperation. |
| AC-5.11.4 | A dated quarterly review exists. |
| AC-5.11.5 | Every open advisory has a current applicability assessment. |
| AC-5.11.6 | Every secret has a rotation procedure; signing rotation includes the announcement. |

---

## 5.12 Incident response

### 5.12.1 Classification

| Class | Definition | Response |
|---|---|---|
| SEV-1 | Platform unavailable, or data loss occurring, or unauthorised access to private content | Immediate, all other work stops |
| SEV-2 | A safety function impaired: reporting, moderation, evidence, mandatory notices | Immediate |
| SEV-3 | A feature broken, no safety or data impact | Next working session |
| SEV-4 | Degradation or cosmetic defect | Scheduled |

**Requirement.** Impairment of a safety function is SEV-2 **even when no user has
noticed**. A reporting mechanism that silently fails is the most consequential defect
class this platform has, and it is invisible to volume metrics.

### 5.12.2 Procedure

| # | Step | Requirement |
|---|---|---|
| IR-1 | Record the start | Time, reporter, first symptom. Before diagnosis, so the timeline is real. |
| IR-2 | Classify | Per §5.12.1. Re-classify as understanding changes, recording each change. |
| IR-3 | Contain | Stop harm before diagnosing cause. Emergency controls (Volume IV §4.15) are for this step. |
| IR-4 | Preserve | Capture logs, diagnostic events and relevant audit ranges **before** remediation alters them. |
| IR-5 | Diagnose | |
| IR-6 | Remediate | Smallest change that resolves. A revert is preferred over a forward fix under pressure (Volume I §1.8.6). |
| IR-7 | Verify | The original symptom is gone, and no new diagnostic class has appeared. |
| IR-8 | Communicate | §5.12.3. |
| IR-9 | Record the end | Time, what was done, what was lost, what remains outstanding. |
| IR-10 | Review | §5.12.4. |

**Requirement on IR-4.** Remediation frequently destroys the evidence needed to understand
the cause — a restart clears in-memory state, a revert removes the code. Preservation
precedes remediation.

### 5.12.3 Communication

| Audience | When | Content |
|---|---|---|
| Affected users | Availability incident exceeding a stated duration; any incident affecting their data | What happened, what is affected, whether data was lost, what to do, when the next update comes |
| The institution | SEV-1 or SEV-2 | The above, plus what is being done |
| A person whose private content was accessed without authorisation | Always, without exception | What was accessed, when, by whom if known, what is being done, and what they can do |

**Requirements.**

- Communication MUST NOT overstate certainty. "We are still determining whether" is
  acceptable; a premature "no data was affected" is not, and is unrecoverable if wrong.
- Communication MUST NOT be delayed pending a complete understanding. An initial notice
  with a commitment to update is better than silence.
- A notice concerning a minor's data MUST be delivered through a channel the institution
  can corroborate, not only in the application.

### 5.12.4 Post-incident review

**Requirements.**

| # | Requirement |
|---|---|
| PIR-1 | Held for every SEV-1 and SEV-2, and recorded. |
| PIR-2 | MUST establish the mechanism, not a responsible person. |
| PIR-3 | MUST answer: what would have detected this sooner, and what would have prevented it. |
| PIR-4 | MUST produce actions with owners. An action without an owner is not an action. |
| PIR-5 | Where a control existed and did not fire, the review MUST establish why — the most valuable finding available. |
| PIR-6 | Where a rule in this specification would have prevented it and was not followed, the review MUST record why it was not followed. A rule routinely not followed is a rule that is wrong or unenforced, and either is a finding. |
| PIR-7 | Where a new invariant is warranted, it MUST be added to §0.7 with a build-failing test. |

### 5.12.5 Acceptance criteria for §5.12

| # | Criterion |
|---|---|
| AC-5.12.1 | Classification distinguishes safety impairment as SEV-2 regardless of user impact. |
| AC-5.12.2 | Preservation precedes remediation in the runbook. |
| AC-5.12.3 | Communication obligations are documented per audience. |
| AC-5.12.4 | Every SEV-1 and SEV-2 has a recorded review with owned actions. |
| AC-5.12.5 | Reviews establishing a new invariant have added it with a test. |

---

## 5.13 Launch readiness

### 5.13.1 Purpose

Define, in advance and in terms that cannot be argued down under delivery pressure, what
must be true before the platform carries real students.

### 5.13.2 Blocking criteria

Each MUST be satisfied and evidenced. A criterion cannot be waived; it can only be
satisfied or the launch deferred.

**Safety**

| # | Criterion | Evidence |
|---|---|---|
| LR-1 | Reporting works from every content surface, for every target type | Test results per surface and type |
| LR-2 | An urgent report notifies moderators, and no preference can suppress it | Test with preferences disabled |
| LR-3 | Evidence is captured, immutable at the storage layer, and readable only under its own capability with both trails written | Test results |
| LR-4 | Deletion holds prevent destruction of held content, including by administrators | Test results |
| LR-5 | Suspension ends every session immediately | Test with a pre-existing session |
| LR-6 | Every mandatory notice delivers, and a failure to enqueue rolls back its act | Test results |
| LR-7 | An appeal is reachable without a session and survives the enforcement ending | Test results |
| LR-8 | The published response commitment is monitored and pages when exceeded | Signal configuration |

**Security**

| # | Criterion | Evidence |
|---|---|---|
| LR-9 | All boot guards fail closed in production | Boot output per guard |
| LR-10 | All six authorization guards pass | Suite output |
| LR-11 | Every sensitive action is gated **and** spent | Guard output |
| LR-12 | Suspension is enforced at all three doors by one predicate | Guard and behavioural test output |
| LR-13 | Every open advisory has a current applicability assessment | The assessments |
| LR-14 | Owner count is two; both accounts intended; recovery channels independent | Recorded review |
| LR-15 | Every break-glass procedure has a dated drill | Drill records |

**Data**

| # | Criterion | Evidence |
|---|---|---|
| LR-16 | Backups are scheduled, off-host, integrity-verified, multi-generation | Configuration plus a verification record |
| LR-17 | **A restore drill has been performed** with full verification | Dated drill record |
| LR-18 | Migrations apply to a production copy with row and child parity | Before/after counts |
| LR-19 | Ledger/derivation parity passes | Command output |
| LR-20 | Retention periods match the published policy | Test per class |
| LR-21 | Backup retention is disclosed in the privacy policy | The policy text |

**Legal**

| # | Criterion | Evidence |
|---|---|---|
| LR-22 | All published documents verify by hash at boot and answer over HTTP | Boot log plus per-document status |
| LR-23 | Consent is captured at registration, referencing version and hash | Test results |
| LR-24 | Every consent link resolves to the registry document the acceptance names | Test results |
| LR-25 | No fabricated acceptance history exists in the launch database | Query output |
| LR-26 | Published claims match implemented behaviour, item by item | Reconciliation record |

**Operations**

| # | Criterion | Evidence |
|---|---|---|
| LR-27 | Alert delivery tested to a channel received away from a machine | Dated test |
| LR-28 | Every page-severity signal has a documented procedure | The runbooks |
| LR-29 | Mail configured and delivery-tested | Send record |
| LR-30 | Provider redirect target set to the real callback and registered | Configuration plus a successful sign-in |
| LR-31 | Maintenance mode tested end to end | Test record |
| LR-32 | Host provisioning is repeatable, and a rebuild has been performed once | The record |
| LR-33 | Incident procedure rehearsed at least once | The rehearsal record |

**Product honesty**

| # | Criterion | Evidence |
|---|---|---|
| LR-34 | No interface offers an action with no endpoint | Contract guard output |
| LR-35 | No dashboard figure is fabricated or sampled | Review record |
| LR-36 | Every unimplemented surface reads as unavailable rather than broken | Review record |
| LR-37 | Every known limitation is recorded where a user or the institution can find it | The record |

### 5.13.3 Non-blocking, recorded

The following do not block launch and MUST be recorded as outstanding with an owner, so
that their absence is a decision rather than an oversight.

| # | Item |
|---|---|
| NB-1 | Audit-log viewer (Volume IV §4.4) |
| NB-2 | User-management surface (Volume IV §4.2.5) |
| NB-3 | Organizer demotion and feature restriction (Volume III §3.5.2) |
| NB-4 | Suspension normalisation sweep (§5.6.3) |
| NB-5 | Impersonation (Volume IV §4.6) |
| NB-6 | Organization records (Volume IV §4.7) |
| NB-7 | Impact dashboard (Volume IV §4.9) |
| NB-8 | Multi-tenancy (Volume IV §4.12) |

**Requirement.** NB-1 MUST be recorded as the highest-priority outstanding item, because
the published administrative responsibilities policy's accountability claims rest on a
record no administrator can read.

### 5.13.4 The assessment document

**Requirements.**

| # | Requirement |
|---|---|
| LA-1 | The assessment MUST state, per criterion, satisfied or not, with the evidence. |
| LA-2 | It MUST state every residual risk from Volume II §2.12 and Volume III §3.4.9. |
| LA-3 | It MUST state every non-blocking item with an owner. |
| LA-4 | It MUST NOT describe an intention as a result. |
| LA-5 | It MUST be signed by the platform owner, with a date. |
| LA-6 | It MUST be re-taken for any subsequent launch to a new institution. |

### 5.13.5 Acceptance criteria for §5.13

| # | Criterion |
|---|---|
| AC-5.13.1 | Every blocking criterion has evidence produced for this launch. |
| AC-5.13.2 | LR-17 is satisfied by a dated drill, not by a scheduled backup. |
| AC-5.13.3 | Every residual risk is carried into the assessment. |
| AC-5.13.4 | Every non-blocking item has an owner. |
| AC-5.13.5 | The assessment is signed and dated. |

---

## 5.14 Volume V acceptance summary

Volume V is satisfied when:

- Every acceptance criterion in §§5.2.8, 5.3.6, 5.4.3, 5.5.5, 5.6.5, 5.7.5, 5.8.6, 5.9.8,
  5.10.2, 5.11.5, 5.12.5 and 5.13.5 holds.
- INV-017 and INV-020 are enforced by tests observed to fail against introduced
  violations.
- Every runbook has a dated execution record.
- The restore drill has been performed after the most recent schema rebuild.
- The launch readiness assessment is complete, evidenced and signed.

**Cross-references.** Volume I §1.6 constrains the migrations §5.9 must eventually port.
Volume II §2.11 specifies the break-glass procedures §5.13 requires drills for. Volume IV
§4.5.5.11 specifies the health surface that displays every guard in §5.3.2. Volume VI
sequences the phases that close the non-blocking items in §5.13.3.
