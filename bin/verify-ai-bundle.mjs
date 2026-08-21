#!/usr/bin/env node
/**
 * Proves that a build without on-device AI does not carry the AI runtime.
 *
 * ── Why this exists as a script and not a test ──
 *
 * `src/ai/bundleCost.test.js` runs on every push and checks the SHAPE of the
 * code: one static import, one guarded dynamic import, and the guard written as
 * a raw `import.meta.env` literal. That catches the regression that actually
 * happens, which is somebody adding an import, and it costs milliseconds.
 *
 * What it cannot check is whether the bundler still honours the shape. That
 * needs two real builds and about a minute, which does not belong in a suite
 * people run before every push — a slow suite gets skipped, and a skipped suite
 * prevents nothing.
 *
 * So this belongs to the release checklist, and specifically to any release that
 * moves Vite or Rolldown. The property is known to be fragile: measured on
 * 2026-08-15 against Vite 8.1, guarding the import with a constant imported from
 * `config.js` rather than with the literal shipped 7.5 MB — the runtime chunk
 * and `wllama.wasm` — into a build with the feature switched off. Nothing
 * failed, nothing warned; every student would simply have downloaded it.
 *
 *   node bin/verify-ai-bundle.mjs
 *
 * Exits non-zero if an AI asset appears in the flag-off build.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * What counts as an AI asset.
 *
 * `pdf` is here because the certificate reader pulls in `pdfjs-dist`, which is
 * roughly two megabytes and is gated behind the same flag. Leaving it out made
 * the script report a pass while listing only part of what it had actually
 * kept out of the default build — accurate on the verdict, misleading on the
 * evidence.
 */
const AI_PATTERN = /wllama|pdf|\.wasm$/i;

function build(outDir, env) {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
}

/** Every file under a directory, with its size, relative to that directory. */
function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, found);
    else found.push({ name: path.relative(base, full), bytes: statSync(full).size });
  }
  return found;
}

const total = files => files.reduce((sum, f) => sum + f.bytes, 0);
const kb = bytes => `${Math.round(bytes / 1024).toLocaleString()} KB`;

/**
 * Two stable directories, reused, and never deleted by this script.
 *
 * `vite build --emptyOutDir` clears each one itself before writing, so a run
 * always measures only its own output and the pair does not grow. That leaves
 * this file with no delete call at all, which is the point:
 * `server/tooling.scriptSafety.test.js` requires every `bin/` script that can
 * remove a file to run the shared database safety gate, and a build-measuring
 * tool has no business importing a gate about disposable databases. Reaching
 * for a differently-spelled delete to slip past that scan would be defeating a
 * check rather than satisfying it — so there is simply nothing to delete.
 */
const offDir = path.join(tmpdir(), 'wev-ai-bundle-off');
const onDir = path.join(tmpdir(), 'wev-ai-bundle-on');

{
  process.stdout.write('Building without on-device AI… ');
  /* Empty string rather than absent: the shell may already export it. */
  build(offDir, { VITE_LOCAL_AI: '' });
  const off = walk(offDir);
  console.log(kb(total(off)));

  process.stdout.write('Building with on-device AI…… ');
  build(onDir, { VITE_LOCAL_AI: 'true' });
  const on = walk(onDir);
  console.log(kb(total(on)));

  const leaked = off.filter(f => AI_PATTERN.test(f.name));
  const included = on.filter(f => AI_PATTERN.test(f.name));

  console.log(`\nDifference: ${kb(total(on) - total(off))}`);

  if (included.length === 0) {
    /**
     * The flag-on build having no AI assets means the comparison proved
     * nothing — most likely because nothing in `src/` imports `src/ai/index.js`
     * yet, so both builds legitimately exclude it. Reporting a pass here would
     * be reporting a test that did not run.
     */
    console.error(
      '\nINCONCLUSIVE: the flag-on build contains no AI assets either.\n'
      + 'Nothing in src/ reaches src/ai/index.js, so there is nothing to leak.\n'
      + 'This check only means something once a screen uses the assistant.',
    );
    process.exit(2);
  }

  if (leaked.length > 0) {
    console.error('\nFAIL: on-device AI assets are in a build with the feature off:');
    for (const f of leaked) console.error(`  ${f.name}  ${kb(f.bytes)}`);
    console.error(
      '\nThe dynamic import in src/ai/index.js is no longer being eliminated.\n'
      + 'Check that its guard is still written as a raw import.meta.env literal —\n'
      + 'an imported constant does not fold across the module boundary.',
    );
    process.exit(1);
  }

  console.log(`\nPASS: ${included.length} AI asset(s) present only in the flag-on build.`);
  for (const f of included) console.log(`  ${f.name}  ${kb(f.bytes)}`);
}
