# Demo Reset Procedure

Use this procedure to reset the pilot environment to a clean state for the next group of testers.

## Resetting the Database

The pilot environment uses an entirely separate database file (`pilot.db`) from your local development environment. Because of this, restoring a clean pilot state is as simple as deleting the file and re-running the seeding script.

Run the following command from the project root:

```bash
# This script deletes pilot.db and creates a fresh one with all demo users and events.
node bin/seed-pilot.js
```

## What this resets:
- **Events:** Restores the exact 6 realistic test events (some open, some past).
- **Users:** Restores 1 Admin, 5 Organizers, and 20 Students.
- **Applications:** Restores the simulated applications, waitlists, and withdrawn applications.
- **Hours & Certificates:** Clears all newly earned hours and restores the baseline 5 hours on the past test events.

## Restarting the Server
If you are running the server against the `pilot.db` (e.g. `WEV_DB_PATH=pilot.db npm run dev`), you do **not** need to restart the server. The `seed-pilot.js` script safely resets the file in place.
