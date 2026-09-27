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

Addresses are deliberately not written here — this repository is on GitHub, and the
register's job is to say *which accounts hold access and why*, which it can do without
publishing anybody's mailbox. Reconcile against `users.role` to match rows to addresses.

| Account | Role | Capabilities beyond the role | Granted | Granted by | Reason |
|---|---|---|---|---|---|
| *(the operator's own account)* | `super_admin` | — | 2026-09-08, `bootstrap-owners.mjs` | — | Platform owner. The account actually in use. |
| *(the project mailbox account, `owner_…` username)* | `super_admin` | — | 2026-09-08, `bootstrap-owners.mjs` | — | Second owner, created in the same bootstrap run as the first. **Unclaimed — see below.** |

### The second owner is unclaimed, and that is the state to resolve

It has never signed in and has no second factor. Neither fact is an anomaly:
`bootstrap-owners.mjs` creates an account whose password is a bcrypt hash of 32 random
bytes that were discarded in memory, so it is *claimed* through **Forgot password** rather
than handed a credential. `tfa_enabled = 0` on a bootstrap account is documented as "the
policy working, not a fault" — `REQUIRE_ADMIN_2FA` cannot be false in production, so the
account is refused every capability with `403 tfa_required` until it enrols.

So it cannot be used by anybody who does not control that mailbox. It is not an open door.

**But unclaimed is the worst of the three available states.** A second owner exists to be
the recovery path when the first is locked out — and an account that must first be claimed
under pressure, by somebody who has never done it, is not a recovery path. Meanwhile it is
a standing grant on a mailbox, and whoever controls that mailbox can take it.

Two ways to resolve it, and either is better than leaving it:

1. **Claim it.** Sign in via Forgot password, enrol a second factor, store the recovery
   codes somewhere that is not the same place as the first account's. Then it is a real
   break-glass account and this row stops being a caveat.
2. **Revoke it.** `node bin/revoke-ownership.mjs <address> "<reason>"` — confirms
   interactively, bumps `token_version`, writes `OWNER_REVOKED`. It refuses to remove the
   last owner, so the first account is never at risk.

**Until one of those happens, treat this platform as having one administrator**, with the
consequences in the next paragraph.

**One *effective* administrator is a known limitation, and it is disclosed rather than
hidden.** With a single administrator, an appeal against a suspension that administrator
issued cannot be decided inside the application at all — `appeals.js` refuses it, and no
privilege level overrides that refusal. The Community Guidelines say so in plain words.
A second *claimed* administrator is what closes it; the unclaimed row above does not.

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
| 2026-09-27 | **Corrected against production.** The register recorded one account and said "sole administrator at launch"; the database has held **two** `super_admin` accounts since 2026-09-08, both created in the same `bootstrap-owners.mjs` run. Found during the launch-checklist audit, not by a review — the quarterly access review below had never run. The second account is recorded, and its unclaimed state written down rather than left as a discrepancy between this file and the database. | Operator |
