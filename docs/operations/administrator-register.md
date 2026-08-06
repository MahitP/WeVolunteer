# Administrator register

The list of every account that holds administrator access to WeVolunteer, and why.

**This file is named in a published policy.** The Admin Responsibilities Policy tells
administrators that a register exists, where it is, and that "if you are not on it, you
should not have the access." That makes this file part of a commitment rather than a
convenience — it has to be real, and it has to be current.

## Why it lives here and not in the database

Deliberately outside the application's own data. A database that is broken, restored
from an older backup, or tampered with must not also be the only record of who had
access to it — that is precisely the situation in which the question "who could have
done this?" matters most, and precisely when the database is the least trustworthy
place to ask it.

The repository is version controlled, so every addition and removal carries its own
date and author whether or not anybody remembers to write one in the table below. That
is the property the database cannot offer here.

This is a record, not a control. The access itself is granted by the `role` column and
`user_capabilities`, and `admin.create` is the capability that permits granting it. If
this file and the database ever disagree, **the database is what is true and this file
is what is wrong** — reconcile it at the next access review and note the discrepancy.

## Current administrators

| Account | Role | Capabilities beyond the role | Granted | Granted by | Reason |
|---|---|---|---|---|---|
| *(the operator's own account)* | `super_admin` | — | Pre-launch | — | Platform owner. Sole administrator at launch. |

**One administrator is a known limitation, and it is disclosed rather than hidden.**
With a single administrator, an appeal against a suspension that administrator issued
cannot be decided inside the application at all — `appeals.js` refuses it, and no
privilege level overrides that refusal. The Community Guidelines say so in plain words.
Adding a second administrator is what closes it.

## Access review

Quarterly, and immediately whenever anyone's role changes, as the Admin Responsibilities
Policy states. Each review:

- reconciles this table against `users.role` and `user_capabilities`;
- removes access for anyone whose role changed or who left;
- reads a sample of `admin_audit_logs` for access without an apparent work reason.

With one administrator this is a self-review. That is a real weakness and the policy
prints it rather than implying an oversight process that does not exist.

## Log

| Date | Change | By |
|---|---|---|
| 2026-08-06 | Register created as part of the v1.0 policy release. | Operator |
