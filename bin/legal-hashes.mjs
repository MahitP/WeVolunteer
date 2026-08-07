#!/usr/bin/env node
/**
 * Prints the current sha256 of every published legal document.
 *
 * `server/legalDocuments.js` pins each document's hash as a constant, and
 * `server/consent.test.js` fails the build when a file no longer matches. That
 * is deliberate: an acceptance record's whole value is the CONTENT it points
 * at, so a published document changing without a version bump means every
 * acceptance row for that version now describes text nobody agreed to.
 *
 * When a document changes legitimately:
 *
 *   1. Decide whether it is MAJOR (a reader of the old version would be
 *      surprised or worse off → re-consent) or MINOR (a clarification).
 *   2. Bump `version` in server/legalDocuments.js.
 *   3. Run this and paste the new `contentHash`.
 *
 * Mirrors bin/migration-checksums.mjs, which exists for the same reason and
 * solves the same problem for the migration registry.
 */
import { LEGAL_DOCUMENTS, hashPolicyFile, LEGAL_HASHES_ENFORCED } from '../server/legalDocuments.js';

let drifted = 0;

console.log('\nLegal document hashes\n');
for (const doc of LEGAL_DOCUMENTS) {
  const actual = hashPolicyFile(doc.file);
  const ok = actual === doc.contentHash;
  if (!ok) drifted += 1;
  console.log(`${ok ? '  ok  ' : ' DRIFT'} ${doc.slug} v${doc.version}`);
  console.log(`        file:   ${doc.file}`);
  console.log(`        pinned: ${doc.contentHash}`);
  if (!ok) console.log(`        actual: ${actual}`);
  console.log('');
}

if (drifted > 0) {
  if (LEGAL_HASHES_ENFORCED) {
    console.log(
      `${drifted} document(s) differ from their pinned hash.\n`
      + 'If the change is intentional, bump the version in server/legalDocuments.js\n'
      + 'and replace contentHash with the "actual" value above. Do NOT update the\n'
      + 'hash while leaving the version alone: that silently rewrites what existing\n'
      + 'users are recorded as having agreed to.\n'
    );
    process.exit(1);
  }

  /**
   * Advisory before launch — see LEGAL_HASHES_ENFORCED in legalDocuments.js.
   *
   * Still printed, and still printed as DRIFT above, because this command exists
   * to answer "what has moved". Exit 0 because nothing is wrong: the whole point
   * of the owner's decision is that editing a policy file mid-draft is not a
   * failure, and a non-zero exit here would keep failing whatever CI step runs it.
   */
  console.log(
    `${drifted} document(s) differ from their pinned hash.\n`
    + 'Not an error before launch: hashes are advisory (LEGAL_HASHES_ENFORCED is\n'
    + 'false in server/legalDocuments.js). The server serves the files as written\n'
    + 'and records what it actually published.\n\n'
    + 'At launch, paste the "actual" values above into LEGAL_DOCUMENTS and set\n'
    + 'LEGAL_HASHES_ENFORCED to true.\n'
  );
  process.exit(0);
}

console.log('All documents match their pinned hashes.\n');
