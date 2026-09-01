# Bootstrapping platform ownership

How a `super_admin` comes into existence, and why it cannot happen any other way.

## The rule

**Nothing the application runs can create an owner.** There is no endpoint, no seed, no
migration and no fixture. `server/demoOwnerGuard.test.js` fails the build on any server
module that assigns the role, and `db.js` refuses to boot a demo database containing the
seeded owner removed in v1.2.0.

That is deliberate and it is the strongest control on this platform. A permission check can
be misconfigured; a mechanism that does not exist cannot be. Everything below requires direct
access to the database file.

## Creating the first owners

```bash
node bin/bootstrap-owners.mjs <email> [<email> ...]
```

Creates the account if it does not exist, promotes it if it does, and writes an
`OWNER_GRANTED` audit row. Idempotent — a second run against the same address reports that it
is already an owner and changes nothing.

**Addresses are arguments and are never written to any file.** Do not add them to the script,
to a committed shell alias, or to this document.

### The account has no usable password

A newly created owner holds a bcrypt hash of 32 random bytes that were generated in memory and
discarded. No preimage exists anywhere — not in the repository, not in a terminal scrollback,
not in a shell history.

The owner claims the account through **Forgot password**, which proves control of the mailbox.
That is a stronger claim than a password handed over in a terminal, and it means no credential
ever existed to leak.

An account that was **promoted** rather than created keeps whatever password it already had.
Somebody already signs in with it, and replacing their credential mid-promotion would lock
them out of the account being promoted. Rotate it afterwards.

## Granting and revoking later

```bash
node bin/grant-ownership.mjs <email> "<reason>"
```

```bash
node bin/revoke-ownership.mjs <email> "<reason>"
```

Both confirm interactively, bump `token_version` so existing sessions die, and write
`OWNER_GRANTED` / `OWNER_REVOKED` with `method=CLI` and the operator's login and host.

`revoke-ownership.mjs` refuses to remove the last owner. A platform with no owner has no way
to make another except this script, and the person who needs it is usually the one locked out.

## The first sign-in, and the second factor

`REQUIRE_ADMIN_2FA` cannot be `false` in production — `config.js` refuses the boot — so an
owner account with no second factor is refused **every capability** with
`403 code: tfa_required` until it enrols. That is the policy working, not a fault, and it
applies on the first production sign-in: an account created by `bootstrap-owners.mjs`, or
promoted by `grant-ownership.mjs`, has `tfa_enabled = 0`.

It is not a lockout. The enrolment endpoints are gated by `requireAAL2` — "prove it is still
you", satisfied by re-entering the password — and **not** by `requireCap`, which is the gate
that consults `tfaRequired`. So the order on first sign-in is:

1. Sign in with the password.
2. Open Settings → Security. `GET /api/2fa/status` is readable and reports
   `roleRequires2FA: true`.
3. Re-verify the password when prompted, then `POST /api/2fa/generate` and
   `POST /api/2fa/enable` with a code from the authenticator.
4. Store the recovery codes. Every capability unlocks once a factor is enabled.

Administrative surfaces will refuse with `tfa_required` until step 3 completes, so do this
before anything else rather than reading the refusal as a broken deployment.

`routes.2faHardening.test.js` pins both halves — that an administrator without a factor is
refused, **and** that the same account can still reach enrolment. The second case exists
because adding a `tfaRequired` check to `requireAAL2` would lock every owner out permanently
while leaving the first case green.

## Rotation

**Rotate owner passwords on a schedule.** An owner account is the only one on this platform
that nobody else can suspend, demote or lock out — `suspensionTargetError` refuses to suspend
a `super_admin` even for another `super_admin`, because the failure mode is a platform nobody
can recover.

Rotate immediately if an owner account was promoted from an existing one, if a device with a
saved session is lost, or if anyone leaves the project.

## What an owner can do that an administrator cannot

- Read the administrative audit trail (`audit.read`, `/admin/audit-logs`)
- Promote and revoke administrators (`admin.create`, `/admin/roster`)
- Read the error dashboard (`error.read`, `/errors`)
- Suspend or unsuspend an administrator
- Review a report or appeal naming themselves, recorded as a self-review

Everything else an owner sees, an administrator sees. In particular an ordinary administrator
holds `report.evidence.read` — the ability to read students' private message bodies preserved
with a safety report. That is the most invasive power on the platform and it is **not**
owner-only. Bear it in mind when deciding who becomes an administrator.
