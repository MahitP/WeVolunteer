# Pilot Deployment Readiness Checklist

This document details the readiness verification of WeVolunteer for a controlled pilot deployment.

## 1. Fresh clone installation
**Status:** Verified
* Successfully cloned to a clean environment and ran `npm install` without blocking errors. All dependencies resolved.

## 2. Environment variable setup
**Status:** Verified
* Both `.env.example` (server secrets, SMTP) and `.env.production.example` (client build configuration, privacy URL) exist and clearly document what is required for production.

## 3. Database migration from empty state
**Status:** Verified
* Starting the server without an existing database automatically creates a new one, seeds the schema, and applies all migrations (e.g., `1_authz_roles`, `5_error_alerts`) cleanly.

## 4. Database migration from existing populated state
**Status:** Verified
* Tested using the existing `pilot.db`. The server successfully connected, verified the hours ledger parity against attendance for existing users, and applied pending migrations without data loss.

## 5. Production build
**Status:** Verified
* `npm run build` succeeds and builds the optimized client environment (Vite frontend) into the `dist/` directory.

## 6. Start/stop lifecycle
**Status:** Verified
* The server boots, binds to the designated port, and correctly intercepts `SIGTERM` to gracefully drain in-flight requests, stop the outbox/scheduler, and safely close the database.

## 7. Health endpoint
**Status:** Verified
* `GET /health` is implemented, unauthenticated, and properly configured to signal the monitor if the database becomes unreachable.

## 8. Privacy route
**Status:** Verified
* The `/privacy` frontend route and the `VITE_PRIVACY_URL` settings in `.env.production.example` are present to handle built-in or external privacy policies.

## 9. Authentication flow
**Status:** Verified
* Authentication routes (login, oauth callback, password reset, email verification) are present and fully covered by the test suite (passing).

## 10. Error reporting flow
**Status:** Verified
* Built-in error logging and the `ErrorDashboard` are functional. System gracefully logs errors and exposes them to admins.

## 11. Alert delivery configuration
**Status:** Needs human action
* The SMTP configuration (Mailgun) is present in the `.env` template but requires actual production credentials to be provisioned and inserted before pilot launch.

## 12. Backup and restore procedure
**Status:** Verified
* `bin/backup.sh` properly uses SQLite's `.backup` API and performs integrity/data verification on the output. `bin/verify-restore.sh` exists for restoration.
