#!/usr/bin/env node
/**
 * Prints the checksum each registered migration would record today, and the SQL
 * to backfill `schema_migrations` with it.
 *
 * Needed because a change to the checksum SCHEME invalidates every previously
 * recorded checksum at once, and the resulting boot failure asks the operator
 * for a value they have no way to compute by hand. v1.2a rebased checksums from
 * `String(migration.up)` onto the canonicalised source of the whole migration
 * file — see docs/ENGINEERING_GUIDE.md section 8.5.
 *
 * READ-ONLY BY CONSTRUCTION. This script opens no database: it imports the
 * migration registry (which depends on nothing but node:crypto and node:fs) and
 * hashes files on disk. It prints SQL for a human to review and apply; it never
 * executes any. That is why it is absent from the destructive-tool gate in
 * server/tooling.scriptSafety.test.js — there is nothing here to gate.
 */
import { MIGRATIONS, checksumFor } from '../server/migrations/index.js';

const rows = [...MIGRATIONS]
  .sort((a, b) => a.version - b.version)
  .map((m) => ({ version: m.version, name: m.name, checksum: checksumFor(m) }));

console.log('Current migration checksums\n');
for (const r of rows) {
  console.log(`  ${String(r.version).padStart(3, '0')}_${r.name}`);
  console.log(`    ${r.checksum}`);
}

console.log('\nBackfill SQL — apply ONLY to a database where every migration below');
console.log('is already applied and its schema change verified present:\n');
for (const r of rows) {
  console.log(
    `UPDATE schema_migrations SET checksum = '${r.checksum}' WHERE version = ${r.version};`
  );
}
console.log('\nVerify afterwards with:');
console.log('  SELECT version, name, checksum FROM schema_migrations ORDER BY version;');
