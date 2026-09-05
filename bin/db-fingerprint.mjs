#!/usr/bin/env node
/**
 * Print the non-secret fingerprint of a database, for WEV_PRODUCTION_DB_FINGERPRINT.
 *
 * Run this ONCE against production, then set the value it prints in every other
 * environment — preview, staging, local. Those environments then know what
 * production looks like without holding a single production credential, and
 * refuse to boot if they find themselves pointed at it.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node bin/db-fingerprint.mjs
 *   node bin/db-fingerprint.mjs postgres://...
 *
 * The output is a hash of host:port/database. It contains no username, no
 * password, and no part of the connection string in recoverable form, so it is
 * safe to paste into a dashboard, a runbook or a pull request.
 */
import { databaseFingerprint } from '../server/db/productionDatabaseGuard.js';

const url = process.argv[2] || process.env.DATABASE_URL;

if (!url) {
  console.error('No connection string. Pass one as an argument or set DATABASE_URL.');
  process.exit(1);
}

const fp = databaseFingerprint(url);
if (!fp) {
  // Deliberately does not echo the input: it is a connection string, and this
  // message goes to a terminal that may be shared or recorded.
  console.error('Could not parse that as a postgres:// connection string.');
  process.exit(1);
}

console.log(`WEV_PRODUCTION_DB_FINGERPRINT=${fp}`);
