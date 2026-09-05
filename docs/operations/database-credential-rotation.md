# Rotating the production database password

The current production password is **compromised** — it was pasted into an
assistant chat transcript on 2026-08-19 and must be treated as public. Nothing
in the application prevents it from working, so this is a scheduled task, not an
outage.

Everything below except step 1 can be done from a shell. Step 1 cannot: Supabase
does not let the `postgres` role change its own password
(`ALTER USER postgres WITH PASSWORD …` is refused — the role is not a superuser
on a managed project), so the change has to happen in the dashboard.

## What actually has to change

Verified against the tree on 2026-08-19, not assumed:

- The connection string is read from `DATABASE_URL` in exactly **two** places at
  runtime — `postgresConfig()` in `server/db/engine.js` and `openPrivilegedDb()`
  in `bin/resolveDb.mjs`. Both read `process.env` at call time.
- It is **never cached, persisted, or written to disk.** `server/db.js` parses
  it only to log `host:port/database`, deliberately excluding the password,
  because that line ends up in logs and incident notes.
- `errorReporter.js` redacts credentials out of any connection string before an
  error is grouped or mailed.
- No connection string exists anywhere in git history (checked across all
  objects), in any committed file, or in any test fixture.

So: **change the environment variable and restart.** There is no second place to
update and no cache to clear.

`DATABASE_SSL_CA` is unaffected. `deploy/certs/supabase-root-2021.crt` is a
public certificate, not a secret, and the rotation does not touch it.

## Procedure

**1. Change it in Supabase.** Dashboard → Project Settings → Database → Reset
database password. Generate a long random one; do not reuse anything. Copy it
straight into the password manager — not into a chat, a terminal history, or a
file in the repository.

**2. Update the deployment environment.** Wherever `DATABASE_URL` is set for the
service — for the systemd unit in `deploy/wevolunteer.service` that is
`/etc/wevolunteer/wevolunteer.env`, not a file in the repo.

```bash
sudo systemctl edit --full wevolunteer   # or edit the EnvironmentFile directly
```

`.env` in the working tree is **development-only** and must not carry production
credentials: it is loaded by `bin/resolveDb.mjs` for every privileged CLI tool
and inherited by the test suites. A production `DATABASE_URL` there is what sent
a test suite at the live database on 2026-08-19.

**3. Restart and verify.**

```bash
sudo systemctl restart wevolunteer && sleep 5 && curl -sf localhost:5000/health
```

Expect `{"status":"ok","database":"connected","writable":true,…}`. `writable`
is the part that matters — it proves a real write reached the database, not just
that a socket opened.

**4. Confirm TLS verification is still on.** The rotation should not touch it,
but this is the cheap check that it did not:

```bash
journalctl -u wevolunteer -n 50 | grep -i 'db\]'
```

Expect `[db] using postgres db.<ref>.supabase.co:5432/postgres` and **no**
warning about `DATABASE_SSL_INSECURE`. Production refuses to boot with that set
at all, so a running process is already proof.

**5. Update anything else holding the old password.** A local `psql` alias,
`~/.pgpass`, a GUI client, a CI secret. There is no such secret in this
repository's CI today, so this is about workstations.

## Verifying the old password is dead

From a machine that has the old one, with the new service already running:

```bash
psql "postgres://postgres:<OLD>@db.<ref>.supabase.co:5432/postgres" -c 'select 1'

> **If that psql cannot connect at all**, check the address family before the
> password. `db.<ref>.supabase.co` publishes an **AAAA record and no A record**
> — the direct endpoint is IPv6-only unless the project buys the IPv4 add-on
> (verified by DNS and against Supabase's connection documentation,
> 2026-09-02). From an IPv4-only host, use the session-mode pooler instead,
> which is IPv4 and keeps a stable session:
>
> ```bash
> psql "postgres://postgres.<ref>:<OLD>@aws-<n>-<region>.pooler.supabase.com:5432/postgres" -c 'select 1'
> ```
>
> A wrong password and an unreachable address fail differently, and mistaking
> the second for the first during a rotation is how a rotation becomes an
> outage.
```

Expect `password authentication failed`. If it succeeds, the reset did not take
effect — do not consider the rotation done.

## If it goes wrong

The failure mode is the service unable to connect, which `/health` reports
immediately and loudly. There is no data risk: a wrong password is refused at
the connection, so nothing partially writes.

Roll forward rather than back — reset the password again in the dashboard and
correct the environment. There is no way to restore the previous password, so
"rollback" means "set a known one again".

## Cadence

Rotate on compromise, on any change in who has shell access to the host, and
otherwise annually. Owner account passwords are separate and are covered in
`owner-bootstrap.md`.
