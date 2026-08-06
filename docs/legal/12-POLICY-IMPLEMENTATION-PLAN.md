# Policy Audit — Implementation Plan

Companion to `11-POLICY-AUDIT-2026-08-06.md`. No new audit, no redesign. Every item
from that audit, classified, with exact patch text, exact code locations, and its
version consequence.

---

## 0. Two mechanics that decide every classification below

### 0.1 There is no PATCH tier

The consent-versioning rule (`server/legalDocuments.js:43-46`) defines **MAJOR.MINOR
only**:

> MAJOR means a reasonable reader of the previous version would be surprised or worse
> off — new collection, new sharing, a reduced right, a changed retention period — and
> requires re-acceptance. MINOR is a clarification and requires notice only.

All ten registered versions are two-part (`2.1`, `3.0`, `1.0`…). So this plan uses:

| Tier used here | Meaning | Registry effect |
|---|---|---|
| **NONE** | The published body does not change | No version bump, no hash change, no notice |
| **MINOR** | Clarification | Bump `X.Y` → `X.Y+1`, in-app notice, **no re-consent** |
| **MAJOR** | Reader surprised or worse off | Bump `X.0`, **re-acceptance** for acceptance-bearing docs |

**NONE** is the closest thing to the "PATCH" tier requested. It applies in two cases:
a pure code change that touches no document, or an edit **above** the `## Draft`
marker.

### 0.2 Only four documents can ever force re-consent

`hashPolicyFile` hashes `publishedBody(source)` — everything **after** the `## Draft`
marker (`server/legalDocuments.js:344-357`, asserted by
`server/legalContent.test.js:146`). Text above the marker is an internal drafting
brief: it is not served, not hashed, and editing it is **NONE**.

| Document | consentType | scope | MAJOR forces re-consent? |
|---|---|---|---|
| terms-of-service | agree | signup | **Yes** |
| community-guidelines | agree | signup (bundled with ToS) | **Yes — same checkbox as ToS** |
| privacy-policy | acknowledge | signup | **Yes** |
| organizer-agreement | agree | organizer-onboarding | **Yes, organizers only** |
| youth-safety-guidelines | notice | notice | No — notice only |
| certificate-verification-policy | notice | notice | No |
| volunteer-record-policy | notice | notice | No |
| data-deletion-policy | notice | notice | No |
| cookie-and-tracking-notice | notice | notice | No |
| admin-responsibilities-policy | notice | notice | No |

**Six of ten documents cannot trigger re-consent at all.** Their MAJOR/MINOR label
only decides whether an in-app notice is shown.

`## Draft` marker line per file: 01→57, 02→55, 03→31, 04→43, 05→32, 06→43, 07→34,
08→47, 09→45, 10→41. Every patch in this plan is **below** its marker unless stated,
so every one changes a hash.

### 0.3 The procedure every policy patch shares

1. Edit the `.md` file.
2. `node bin/legal-hashes.mjs` — prints refreshed hashes.
3. Update `contentHash` **and** `version` in `server/legalDocuments.js`.
4. If MAJOR, add a dated entry to the version-history comment block
   (`server/legalDocuments.js:90-124`) saying which documents and why.
5. `npx vitest run server/consent.test.js server/legalContent.test.js server/routes.legal.test.js`
6. Full four gates.

**Skipping step 3 means production refuses to boot** (`verifyPolicyFiles()` in
`server/server.js:58-69`).

`contentHash` line numbers to update: ToS 134 · CG 147 · PP 167 · OA 179 · YSG 191 ·
Cert 203 · VRP 215 · DDP 236 · Cookie 248 · Admin 260.
`version` line numbers: ToS 127 · CG 140 · PP 160 · OA 172 · YSG 184 · Cert 196 ·
VRP 208 · DDP 229 · Cookie 241 · Admin 253.

---

## 1. F-1 — Version strings contradict the acceptance record

**Classification: POLICY CHANGE + CODE CHANGE. Version: MINOR (all four).**

A label correction. Nobody's rights change; the registry version was always the
operative one. No re-consent.

### 1a. Privacy Policy — `docs/legal/policies/01-privacy-policy.md:61`

```
CURRENT:
**Version 2.0 · Last updated 2026-08-05** · Applies to WeVolunteer version 1.2 and later

RECOMMENDED:
**Version 3.0 · Last updated 2026-08-05** · Applies to WeVolunteer version 1.2 and later
```

### 1b. Terms of Service — `docs/legal/policies/02-terms-of-service.md:59`

```
CURRENT:
**Version 2.0 · Last updated 2026-08-05**

RECOMMENDED:
**Version 2.1 · Last updated 2026-08-05**
```

### 1c. Community Guidelines — `docs/legal/policies/03-community-guidelines.md:35`

```
CURRENT:
**Version 2.1 · Last updated 2026-08-05** · Part of the

RECOMMENDED:
**Version 2.2 · Last updated 2026-08-05** · Part of the
```

### 1d. Data Deletion Policy — `docs/legal/policies/04-data-deletion-policy.md:47`

```
CURRENT:
**Version 1.0 · Last updated 2026-08-05**

RECOMMENDED:
**Version 2.0 · Last updated 2026-08-05**
```

### 1e. Admin Responsibilities — insert after `docs/legal/policies/10-admin-responsibilities-policy.md:43`

```
CURRENT:
# Administrator responsibilities

You have been given an administrator account on WeVolunteer.

RECOMMENDED:
# Administrator responsibilities

**Version 1.0 · Last updated 2026-08-05**

You have been given an administrator account on WeVolunteer.
```

### 1f. Correction to the audit — Organizer Agreement needs no patch

`11-POLICY-AUDIT` §2.5 said the Organizer Agreement lacks a "Last updated" date. It
does not. Line 49 reads `**Version 1.0 · 2026-08-05**` — version matches the registry
and the date is present, just not labelled. My detection regex looked for the literal
string `Last updated`. **No edit required.** Optionally normalise the label for
consistency; that would be MINOR and is not worth a hash bump on its own.

### 1g. CODE CHANGE — the guard that stops this recurring

**Version: NONE.** Location: `server/consent.test.js`, inside
`describe('the document registry')` at line 114, alongside the existing
`it('pins a content hash that matches the published file')` at line 115.

```js
  /**
   * The version a reader sees must be the version their acceptance record names.
   *
   * The hash guard above proves the FILE is the one that was pinned. It cannot see
   * the version string INSIDE the file, and four documents had drifted: the page
   * header renders the registry version while the body printed its own, so
   * `/legal/terms-of-service` showed "Version 2.1" above "**Version 2.0**" and the
   * acceptance row said 2.1. In a dispute the question is "what did this person
   * agree to", and the platform answered it two ways on one screen.
   */
  it('prints the registry version and effective date in the document body', () => {
    const wrong = [];
    for (const doc of LEGAL_DOCUMENTS) {
      const body = publishedBody(readFileSync(path.join(POLICY_DIR, doc.file), 'utf8'));
      const version = body.match(/\*\*Version ([0-9]+\.[0-9]+)/)?.[1];
      const dated = body.includes(doc.effectiveAt);
      if (version !== doc.version) {
        wrong.push(`${doc.file}: body says ${version ?? 'no version line'}, registry says ${doc.version}`);
      }
      if (!dated) wrong.push(`${doc.file}: body does not state effectiveAt ${doc.effectiveAt}`);
    }
    expect(wrong, 'version/date drift between a document body and the registry').toEqual([]);
  });
```

Requires `publishedBody`, `POLICY_DIR` and `LEGAL_DOCUMENTS` in scope — the first two
may need adding to the existing import from `./legalDocuments.js`, and `readFileSync`
/ `path` if not already imported in that file.

---

## 2. F-2 — Urgent safety alert defeatable by a preference

**Classification: CODE CHANGE. Version: NONE.** No document changes.

**Location: `server/services/notificationContent.js:37-43`.**

```js
CURRENT:
export const MANDATORY_NOTICE_EVENTS = new Set([
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REINSTATED',
  'APPEAL_DECISION_STANDS',
  'APPEAL_DECISION_REVERSED',
  'APPEAL_REOPENED',
]);

RECOMMENDED:
export const MANDATORY_NOTICE_EVENTS = new Set([
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REINSTATED',
  'APPEAL_DECISION_STANDS',
  'APPEAL_DECISION_REVERSED',
  'APPEAL_REOPENED',
  /**
   * The urgent safety-report alert, and the reason it belongs in this set.
   *
   * `reportService.js` dispatches this to every moderator when a report's derived
   * priority is `urgent` — which a student reporting an adult always is, whatever
   * category they picked. Its own comment says that on a one-to-two-person team this
   * notification is "the only thing standing between that promise and a queue nobody
   * happened to refresh".
   *
   * It was not mandatory, so `dispatch()` fell through to
   * `emailEnabled = user.email_opt_out === 1 ? false : getPref('email')` — and a
   * moderator who had turned email off, globally or for this category, received
   * nothing. The one signal between a child-safety report and an unread queue was a
   * user-preference toggle.
   *
   * Every other entry here is a notice the recipient must get whatever their
   * preferences say. A report that may cause a suspension is at least as
   * consequential as the suspension notice that follows it.
   */
  'SYSTEM_ALERT',
]);
```

**Test constraint checked:** nothing in `server/*.test.js` pins the contents of
`MANDATORY_NOTICE_EVENTS`, so this breaks no existing assertion.

**Add a regression test.** Location: new `server/reportService.alerting.test.js`, or
append to an existing report suite.

```js
it('emails an urgent report alert even when the moderator has email off', async () => {
  // The defect: SYSTEM_ALERT was not mandatory, so a moderator with
  // email_opt_out = 1 got no email for an urgent child-safety report.
  db.prepare('UPDATE users SET email_opt_out = 1 WHERE id = ?').run(moderatorId);
  await createUrgentReport();
  const jobs = db.prepare(
    "SELECT payload FROM notification_jobs WHERE channel = 'email'"
  ).all();
  expect(jobs.some(j => JSON.parse(j.payload).userId === moderatorId)).toBe(true);
});
```

**Scope note.** This fixes urgent reports only. Normal-priority reports still notify
nobody by design (`reportService.js:238`). That design is defensible, but it means
"a report reaches a human within one business day" still depends on someone opening
the queue for non-urgent reports — which is why §7 (E-1) softens the wording rather
than relying on this patch alone.

---

## 3. F-3 — A sole operator can never decide an appeal

**Classification: OWNER DECISION first, then POLICY CHANGE. Version: depends.**

No code change is recommended. `NEVER_OVERRIDABLE` (`server/appeals.js:105`) is
correct and must not be weakened — deciding an appeal against a suspension you issued
has no legitimate privileged form.

### Path A — a second administrator exists before launch (recommended)

**Version: NONE.** No document changes; the published promise becomes true.
Operational task only: create one admin account for a trusted adult.

### Path B — no second administrator

The Community Guidelines promise must change.
**Location: `docs/legal/policies/03-community-guidelines.md:152-155`.**

```
CURRENT:
Submit an appeal using the link provided in your suspension notice. We will notify you
when a decision is made. Your appeal will be reviewed by a different administrator.

RECOMMENDED:
Submit an appeal using the link provided in your suspension notice. We will notify you
when a decision is made.

**An appeal is never decided by the administrator who suspended you.** That is enforced
by the software, not by a promise — it will refuse the decision. Right now WeVolunteer
has one administrator, which means an appeal against a suspension they issued cannot be
decided inside the app at all. If that is your situation we will tell you, and we will
refer your appeal to someone independent outside the platform rather than leave it open
indefinitely.
```

**Version: MAJOR** (Community Guidelines, and therefore the shared ToS checkbox). A
reader of the previous version is unambiguously worse off: they were promised a review
that cannot happen.

**Recommendation: take Path A.** Path B is a MAJOR bump that re-consents every user
in order to publish a worse promise, and it leaves suspended students without a
working appeal — which is a live child-safety and due-process problem, not a
documentation one.

---

## 4. F-4 — A published retention period nothing enforces

**Classification: OWNER DECISION between two paths.**

### Path A — implement the sweep (recommended). CODE CHANGE, Version: NONE

The document already promises this period; making it true changes no text.

**Location 1: `server/workers/retentionWorker.js:43-52`.**

```js
CURRENT:
export const RETENTION = {
  messageDays: 3 * 365,
  auditDays: 365,
  deletedAccountDays: 3 * 365,
};

RECOMMENDED (add the fourth period, keeping the existing comments):
export const RETENTION = {
  messageDays: 3 * 365,
  auditDays: 365,
  deletedAccountDays: 3 * 365,
  /**
   * Applications: 3 years after the event they were for.
   *
   * The Privacy Policy has published this period since v2.0 and nothing enforced it —
   * the only `DELETE FROM applications` statements in the codebase are the event and
   * slot cascades in `eventRoutes.js`. The table that period sits in also says "these
   * periods are enforced by a job that runs every day", so the row was the one false
   * claim in an otherwise accurate table.
   *
   * Measured from the event's last slot rather than from the application, because
   * "long enough to resolve a dispute about a placement" is a statement about the
   * event, and an application filed a year early should not expire a year early.
   */
  applicationDays: 3 * 365,
};
```

**Location 2: `server/workers/retentionWorker.js`, inside `sweep()`** — add to
`countable` (after the `messages` entry, ~line 129) and a matching `DELETE` inside the
transaction (after the `admin_audit_logs` delete, ~line 165):

```js
    applications: db.prepare(`
      SELECT COUNT(*) AS c FROM applications a
       WHERE NOT EXISTS (
         SELECT 1 FROM slots s WHERE s.event_id = a.event_id AND s.end_datetime >= ?
       )
    `).get(applicationCutoff).c,
```

```js
    /**
     * Applications age out with the event, not with the row.
     *
     * Scoped by the event's last slot so an application to a future event is never
     * swept. `attendance` is untouched — that is the credited service record and is
     * retained indefinitely, which `assertPreservedTablesUntouched` enforces.
     */
    db.prepare(`
      DELETE FROM applications
       WHERE NOT EXISTS (
         SELECT 1 FROM slots s WHERE s.event_id = applications.event_id
           AND s.end_datetime >= ?
       )
    `).run(applicationCutoff);
```

with `const applicationCutoff = cutoff(now, RETENTION.applicationDays);` beside the
other three cutoffs (~line 125), and `applications` added to the returned counts.

**Verification required before shipping:** confirm no evidence hold needs to cover
applications the way `RETAINABLE_MESSAGE_PREDICATE` covers messages. An application is
not currently referenced by `report_evidence`; if a report can name one, the sweep
needs the same exemption. **Do not ship without checking this** — the failure mode is
deleting evidence for an open report.

### Path B — correct the text. POLICY CHANGE, Version: MAJOR

**Location: `docs/legal/policies/01-privacy-policy.md:194`.**

```
CURRENT:
| Applications | 3 years after the event | Long enough to resolve a dispute about a placement |

RECOMMENDED:
| Applications | Kept while the event exists, and removed with it | An application is part of the event's record, so it lasts as long as the event does rather than on a clock of its own |
```

**MAJOR**, because "a changed retention period" is named in the rule as MAJOR, and a
reader who understood their applications would be deleted after three years learns
they may be kept longer.

**Recommendation: Path A.** It costs one worker change against a MAJOR bump that
re-consents every user to take away a protection they were told they had.

---

## 5. F-5 — "Reports are not triaged by software"

**Classification: POLICY CHANGE. Version: MINOR** (notice-only document).

**Location: `docs/legal/policies/08-youth-safety-guidelines.md:224`.**

```
CURRENT:
1. **It reaches a human within one business day.** Reports are not triaged by software.

RECOMMENDED:
1. **It reaches a human.** Software sorts reports by how serious the category you picked
   is, and anything a student reports about an adult is treated as urgent whatever
   category they chose — that sorting decides how fast we are told, and it is the only
   thing software decides. No software decides what happens to a report, closes one, or
   acts on an account.
```

**REASON.** As written the sentence is false: `moderation.js` derives priority from the
category, floors a student-reporting-an-adult at `urgent`, and that derived priority is
what decides whether any moderator is notified at all. That is triage. The replacement
states the true and more reassuring fact — the floor for student-reports-adult is a real
protection the old sentence hid — while keeping the guarantee that matters, which is
that no software makes the decision. The "within one business day" clause moves out of
this line and is handled once, in §7 (E-1), rather than being asserted in two documents.

---

## 6. TODO resolutions

### T-1 Postal address — POLICY CHANGE, Version: MINOR

**Location: `docs/legal/policies/02-terms-of-service.md:444-448`.**

```
CURRENT:
The operator named at the top of this document, at:

[[TODO: postal address — required on a published ToS and for regulator and legal correspondence.
Owner to supply the address to print; a home address may not be the right answer, so this may
need a mail-forwarding or registered-agent decision first.]]

RECOMMENDED:
The operator named at the top of this document, at
**wevolunteer.platform@gmail.com**, which is read by that person directly.

If you need to serve a legal document or send regulatory correspondence on paper, email that
address and we will provide a postal address for service. We do not print one here: WeVolunteer
is run by one individual rather than a company, and the only postal address that exists is a
residential one. Publishing the home address of the person who suspends accounts, to the people
whose accounts get suspended, is not a risk we are willing to take — and it is not necessary,
because service can be arranged on request.
```

**MINOR:** replacing an unfilled placeholder with a working contact mechanism. No right
is reduced — a reader gains a route to service they did not have.

**Durable fix (not a text change):** a New Jersey CMRA box (~$150–300/yr) or an LLC with
a registered agent. Once one exists, print it and drop the explanatory paragraph — also
MINOR.

### T-2 Liability cap — OWNER DECISION + POLICY CHANGE, Version: **MAJOR**

**Location: `docs/legal/policies/02-terms-of-service.md:356-359`.**

```
CURRENT:
- For everything else, taken together, our total liability to you is limited to
  **[[TODO: liability cap — owner and counsel to set a figure. See the note below; the drafting
  recommendation is a small, honest number (for example $100) rather than "fees paid," since
  the service is free and "fees paid" would read as zero.]]**

RECOMMENDED:
- For everything else, taken together, our total liability to you is limited to
  **one hundred US dollars ($100)**. WeVolunteer is free, so a cap of "the fees you paid"
  would be a cap of nothing; a small real number is an honest limit rather than a
  disguised zero, and it is more likely to be enforced than an aggressive one.
```

**This is the only MAJOR bump in the plan that is unavoidable.** Introducing a cap
where the published text stated none is "a reduced right" in the words of the rule. It
re-consents every user, and because Community Guidelines is `bundledWith:
'terms-of-service'` both documents re-consent behind **one** checkbox.

**Sequencing consequence:** batch every ToS and Community Guidelines edit into this one
MAJOR release. Do not ship the MINOR label fix (§1b/1c) separately and then this — that
is two consent prompts for one set of changes.

Counsel to confirm the figure before publication (T-9 covers the same review).

### T-3 Policy archive URL — POLICY CHANGE ×3, Version: MINOR each

Identical replacement in three files. **Locations:
`01-privacy-policy.md:361-363`, `02-terms-of-service.md:397-400`,
`05-cookie-and-tracking-notice.md:200`.**

```
CURRENT (Privacy Policy 361-363):
**[[TODO: policy archive URL — depends on the public URL decision. The same TODO appears in the
Terms of Service and the Cookie Notice; all three must resolve to the same real link, because
this is a promise to keep superseded versions readable.]]**

RECOMMENDED (use in all three files, adjusting only the lead-in sentence):
Superseded versions are kept. Until a public archive page exists, email
**wevolunteer.platform@gmail.com** for any previous version and the dates it applied, and we
will send it. Every version is recorded with a content fingerprint, so the copy you receive can
be checked against the one your account accepted.
```

```
CURRENT (Terms of Service 397-400):
Old versions stay available at
**[[TODO: policy archive URL — depends on the public URL decision. Until this is a real link,
the archive commitment in this section, in the Privacy Policy, and in the Cookie Notice is
unkeepable.]]**

RECOMMENDED:
Old versions are kept. Until a public archive page exists, email
**wevolunteer.platform@gmail.com** for any previous version and the dates it applied, and we
will send it. Every version is recorded with a content fingerprint, so the copy you receive can
be checked against the one your account accepted.
```

**MINOR.** The commitment is unchanged; the mechanism becomes one that exists today.
`LEGAL_DOCUMENTS` holds only the current entry per slug, so a real archive page is new
work — do not promise a URL until it is built.

### T-4 / T-5 Email and hosting providers — OWNER DECISION, then POLICY CHANGE, Version: MINOR

**Locations: `docs/legal/policies/01-privacy-policy.md:312` (email) and `:317` (hosting).**

Patch text cannot be written without the answers (Q-1, Q-2 in the audit). Shape:

```
RECOMMENDED (email row, if Google Workspace/Gmail SMTP):
| **Google** (Gmail, for outgoing mail) | Your email address and the message | Sending you notification and security emails |

RECOMMENDED (hosting row, template):
| **<provider name>** | Stores the database | Running the service. Your information is stored on servers in the United States |
```

**MINOR:** naming subprocessors that already receive this data is a disclosure
improvement, not new sharing. **If the answer introduces a subprocessor not already in
the table, that is new sharing and MAJOR** — check before classifying.

If the email answer is Google, merge into the existing Google row (line 313) rather than
adding a second one, and say the account is used for outgoing mail as well as sign-in.

### T-6 Safety-report retention floor — OWNER DECISION + LEGAL REVIEW, Version: **MAJOR**

**Location: `docs/legal/policies/01-privacy-policy.md:220-224`.**

```
CURRENT:
**We have not yet set an end date for safety reports, and we should.** "Indefinitely" is the
honest description of what the software does today, not a considered retention period, and we are
taking legal advice on what the right one is — the answer is tied to how long a person who was a
minor at the time keeps the right to bring a claim in New Jersey, which is a long time. We will
publish the period here when we have it.

RECOMMENDED (subject to counsel confirming the figures):
**How long we keep a safety report.** We keep a report and the messages saved with it for **at
least 7 years, and until the student who filed it turns 25 — whichever is later.** New Jersey
gives someone who was a minor at the time a long window to bring a claim, and a report deleted
inside that window would destroy the record that protects the student who filed it at least as
much as it protects us. After that point we review whether a report can be removed. We will
never delete one while any dispute, appeal, or investigation about it is open.
```

**MAJOR:** "a changed retention period" is named in the rule.

**Do not ship this before counsel confirms**, and note it requires a code change to
enforce (nothing currently expires a report — `PRESERVED_TABLES` in
`retentionWorker.js:67-85` protects `reports` absolutely). Publishing a period without
the sweep would recreate F-4 on the most sensitive table in the database. **Sequence:
counsel → code → text.**

**Related, and separable — do this one now regardless.** The same passage claims "we are
taking legal advice", which is a statement of fact. If no counsel is engaged:

```
CURRENT (same lines, the clause only):
and we are taking legal advice on what the right one is

RECOMMENDED:
and we have not yet taken legal advice on what the right one is, which we intend to do before
setting it
```

**MINOR** — correcting a claim about our own conduct, not a retention change.

### T-7 Monitored hours — OWNER DECISION, then POLICY CHANGE, Version: MINOR

**Location: `docs/legal/policies/08-youth-safety-guidelines.md:198-201`.**

```
CURRENT:
**By email** — **wevolunteer.platform@gmail.com**, monitored
**[[TODO: monitored hours for the safety inbox — the actual hours and days one person reads this
mailbox, in plain words ("weekdays, 8am to 9pm Eastern"). It has to be a commitment that can be
kept by one person, because it is one person. This gates the "within one business day" promise
below: do not publish that promise with this blank, and do not publish hours you cannot hold.]]**

RECOMMENDED (owner to supply the hours; wording pattern):
**By email** — **wevolunteer.platform@gmail.com**, read by one person, usually
**<hours, e.g. every evening and most weekends, Eastern time>**. It is not monitored overnight
and there is nobody covering it when that person is unavailable. **If someone is in danger now,
call 911 — do not email us and wait.**
```

**MINOR.** Filling a blank with a keepable commitment. The final sentence is
load-bearing: it is what makes a one-person inbox a safe thing to publish.

### T-8 Admin Responsibilities — three TODOs — POLICY CHANGE, Version: MINOR

**Locations: `docs/legal/policies/10-admin-responsibilities-policy.md:53`, `:61`, `:156`.**

```
CURRENT (:53):
**[[TODO: approver — name the person (by role, not just "the owner") who authorises a new
administrator...]]**

RECOMMENDED:
**The operator** — currently the only person who can grant an administrator account, because
granting one requires the `admin.create` capability and only the operator holds it.
```

```
CURRENT (:61):
**[[TODO: register location — where the list of current administrators lives, and who can read
it...]]**

RECOMMENDED:
**There is no separate register.** The list of administrators is the platform's own data: the
`role` on each account plus any individually granted capabilities. Anyone holding the
`audit.read` capability can see who holds what, and every grant is written to the audit log.
Keeping a second list in a spreadsheet would only give us two answers that could disagree.
```

```
CURRENT (:156):
**[[TODO: access-review cadence — how often the register and an audit-log sample are reviewed...]]**
Recommended: quarterly, and immediately whenever someone's role changes. Say a period you will

RECOMMENDED:
**Quarterly, and immediately whenever anyone's role changes.** With one administrator this is a
self-review, which is a real limitation and we would rather print it than imply an oversight
process that does not exist. A second administrator would make it a genuine review, and that is
one of the reasons to have one.
```

**MINOR** on all three, and this document is notice-only so there is no re-consent
either way.

### T-9 Remove the internal counsel bracket — POLICY CHANGE, Version: MINOR

**Location: `docs/legal/policies/02-terms-of-service.md:415-416`.**

```
CURRENT:
[[TODO: counsel to confirm the no-arbitration, no-class-action-waiver choice, and confirm New
Jersey law and Middlesex County venue in section 15, before publication.]]

RECOMMENDED:
(delete these two lines entirely)
```

**REASON.** An instruction addressed to counsel, published to users. Distinct from the
§11 "Note for counsel" block, which is deliberately public and should stay — that one
explains a choice to the reader; this one is a work item. Track it outside the document.
Fold into the T-2 MAJOR release.

### T-10 Certificate Verification public URL — OWNER DECISION, Version: MINOR

**Location: `docs/legal/policies/06-certificate-verification-policy.md:59`.** Blocked on
the same production-domain decision as T-3. Interim wording:

```
RECOMMENDED:
Go to the **Verify a certificate** page on WeVolunteer and type the code exactly as printed.
```

**MINOR.** Names a page that exists instead of a URL that does not.

---

## 7. Remaining audit items

### E-1 The "one business day" promise — POLICY CHANGE ×2

**Version: MAJOR for Community Guidelines, MINOR for Youth Safety.**

**Location: `docs/legal/policies/03-community-guidelines.md:143-144`.**

```
CURRENT:
**Our response times:** a report reaches a human within **one business day**. Anything flagged
as a safety concern is looked at **the same day**.

RECOMMENDED:
**Our response times.** Reports about a student's safety are sent to us the moment they are
filed, and we aim to look at those the same day. Everything else we aim to reach within a few
days. WeVolunteer is run by one person, so these are targets and not guarantees — and that is
exactly why the safety hotlines in the [Youth Safety Guidelines](08-youth-safety-guidelines.md)
are the right route for anything urgent. They are staffed around the clock and we are not.
```

**MAJOR:** an SLA is weakened, so a reader of the previous version is worse off. Batch
with T-2. The corresponding clause in Youth Safety is handled by the §5 rewrite (MINOR).

**Depends on F-2 being fixed first.** "Sent to us the moment they are filed" is only
true for urgent reports and only once `SYSTEM_ALERT` is mandatory.

### E-2 "moderation team" — POLICY CHANGE, Version: MINOR

**Location: `docs/legal/policies/03-community-guidelines.md:121-122`.**

```
CURRENT:
Use the **Report** button on any conversation, comment, or event to submit a report
securely to our moderation team.

RECOMMENDED:
Use the **Report** button on any conversation, comment, or event to send us a report
securely. It goes to the WeVolunteer administrators — right now that is one person.
```

**MINOR** in isolation; ship inside the T-2 MAJOR release. Contradicts the Privacy
Policy's "Being one person is the honest answer to 'who monitors this?'" as written.

### E-3 Suspension "for a stated period" — POLICY CHANGE, Version: **MAJOR**

**Location: `docs/legal/policies/03-community-guidelines.md:137-138`.**

```
CURRENT:
| 2 | A warning on your account |
| 3 | Suspension — you cannot sign in, for a stated period |

RECOMMENDED:
| 2 | We tell you what was wrong and that it must not happen again |
| 3 | Suspension — you cannot sign in. A suspension does not expire on its own; it lasts until an administrator lifts it, and you can appeal it |
```

**REASON.** Two separate inaccuracies. Migration 006 adds `suspended_at`,
`suspended_by` and `suspension_reason` and **no expiry column**; nothing expires a
suspension, and the Youth Safety Guidelines and the appeals code both describe
suspension as permanent by default — so the Community Guidelines contradict them.
Separately, `warning_issued` exists only as a moderator *resolution label*
(`server/moderation.js:224`); there is no warning state on an account and nothing
displays one, so "a warning on your account" describes a record that does not exist.

**MAJOR:** learning that a suspension you thought was time-limited is indefinite is the
clearest possible case of a reader being worse off. Batch with T-2.

**Owner alternative:** build suspension durations and keep the text. That is a real
feature and a larger change; correcting the text now does not preclude it.

### E-4 "We are building" certificate voiding — POLICY CHANGE, Version: MINOR

**Location: `docs/legal/policies/01-privacy-policy.md:228-233`.**

```
CURRENT:
**There is currently no way to make your certificates stop being verifiable.** We are building an
option to void them when you delete your account — removing your name and stopping the codes working —
but **it does not exist yet**, so the only accurate thing we can tell you today is that a
certificate you have earned keeps your full name on it, permanently.

RECOMMENDED:
**There is currently no way to make your certificates stop being verifiable.** We would like to add
an option to void them when you delete your account — removing your name and stopping the codes
working — but **it does not exist, and we are not able to promise a date**, so the only accurate
thing we can tell you today is that a certificate you have earned keeps your full name on it,
permanently.
```

**REASON.** "We are building" states work in progress. No such work exists in the
repository. **MINOR** — it withdraws a commitment that was never real rather than
changing a right, and the operative sentence (your name stays on it permanently) is
unchanged and already prominent.

### E-5 5-vs-10 business days — POLICY CHANGE, Version: MINOR

**Location: `docs/legal/policies/07-volunteer-record-policy.md:107`.**

```
CURRENT:
**Step 3 — We respond within 5 business days** and tell you what we found, whether we changed

RECOMMENDED:
**Step 3 — We respond within 10 business days** and tell you what we found, whether we changed
```

**REASON.** Every other document commits the same one person to 10 business days. A
tighter promise for record corrections is not justified by anything and is the easiest
inconsistency for a complainant to point at. **MINOR** — a notice-only document, and
aligning to the figure published everywhere else is a clarification.

**Owner alternative:** keep 5 and explain why records are faster. Not recommended;
there is no mechanism making them faster.

### E-6 Audit-log period silent in Admin Responsibilities — POLICY CHANGE, Version: MINOR

Add to §10 near the "logged and reviewed" language: administrator audit logs are kept
**1 year** (`RETENTION.auditDays`, disclosed in the Privacy Policy). This document
should not be silent where the Privacy Policy is explicit. **MINOR.**

---

## 8. Release batching

The MAJOR/MINOR rule makes batching a correctness question, not a preference: each
MAJOR release on a signup document is a consent prompt to every user.

### Release 1 — code only. Version: NONE. No consent prompt.

| Item | Location |
|---|---|
| F-2 `SYSTEM_ALERT` mandatory + test | `notificationContent.js:37-43` |
| F-1g version/date drift guard | `consent.test.js` §`the document registry` |
| F-4 Path A applications sweep + test | `retentionWorker.js:43-52`, `sweep()` |

Ship first. Nothing here touches a document, so no hash or version work at all, and
F-2 is the highest-value item in the whole plan.

### Release 2 — notice-only documents. Version: MINOR ×6. Notice, no re-consent.

Youth Safety (§5, T-7) · Data Deletion (§1d) · Cookie (T-3) · Certificate Verification
(T-10) · Volunteer Record (E-5) · Admin Responsibilities (§1e, T-8, E-6).

Six documents, six MINOR bumps, six hash updates. No user is asked for anything.

### Release 3 — Privacy Policy. Version: MINOR — *if* T-6 is deferred.

§1a version label · T-3 archive · T-4/T-5 vendor names (once answered) · E-4 "we are
building" · T-6's "taking legal advice" clause only.

Stays MINOR only if F-4 went down Path A and the T-6 retention floor is **not**
included. Adding either retention change makes this MAJOR. Keep them out of this
release deliberately.

### Release 4 — Terms of Service + Community Guidelines. Version: MAJOR. One consent prompt.

T-2 liability cap (the reason it is MAJOR) · §1b, §1c version labels · T-1 postal
address · T-3 archive · T-9 remove counsel bracket · E-1 response times · E-2
"moderation team" · E-3 suspension/warning · F-3 Path B if applicable.

Both documents share one checkbox (`bundledWith: 'terms-of-service'`), so this is a
single prompt. **Every ToS and CG edit in this plan must ship here.** Splitting them
produces two prompts for one set of changes and trains users to click through consent.

Requires: counsel on T-2 and T-9, and the F-3 decision.

### Release 5 — deferred, needs counsel and code

T-6 safety-report retention floor. MAJOR on the Privacy Policy, and it needs the sweep
built first or it recreates F-4 on the most sensitive table in the database.

---

## 9. Summary table

| Item | Class | Version | Blocked on |
|---|---|---|---|
| F-1a–e version strings | POLICY | MINOR ×4 | — |
| F-1f Organizer Agreement | — | NONE | *audit correction: no patch needed* |
| F-1g drift guard | CODE | NONE | — |
| F-2 `SYSTEM_ALERT` mandatory | CODE | NONE | — |
| F-3 appeals deadlock | OWNER → POLICY | NONE (Path A) / MAJOR (Path B) | Q-4 |
| F-4 applications retention | OWNER → CODE or POLICY | NONE (A) / MAJOR (B) | Q-5 |
| F-5 "not triaged by software" | POLICY | MINOR | — |
| T-1 postal address | POLICY | MINOR | — |
| T-2 liability cap $100 | OWNER + POLICY | **MAJOR** | counsel |
| T-3 archive URL ×3 | POLICY | MINOR ×3 | — |
| T-4 email provider | OWNER → POLICY | MINOR | Q-1 |
| T-5 hosting provider | OWNER → POLICY | MINOR | Q-2 |
| T-6 report retention floor | OWNER + LEGAL → CODE + POLICY | **MAJOR** | counsel + sweep |
| T-6b "taking legal advice" | POLICY | MINOR | Q-8 |
| T-7 monitored hours | OWNER → POLICY | MINOR | Q-3 |
| T-8 admin ×3 | POLICY | MINOR | — |
| T-9 counsel bracket | POLICY | MINOR | — |
| T-10 certificate URL | OWNER → POLICY | MINOR | domain |
| E-1 response times | POLICY | **MAJOR** | F-2 first |
| E-2 "moderation team" | POLICY | MINOR | — |
| E-3 suspension period | POLICY | **MAJOR** | — |
| E-4 "we are building" | POLICY | MINOR | Q-10 |
| E-5 5→10 business days | POLICY | MINOR | — |
| E-6 audit-log period | POLICY | MINOR | — |

**Totals:** 3 code changes (all version-NONE) · 19 policy edits · 4 MAJOR-classified
items, all but one landing in a single ToS/CG release · 6 items blocked on an owner
answer · 2 blocked on counsel.
