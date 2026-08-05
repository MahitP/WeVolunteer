/**
 * No source file may contain a NUL byte.
 *
 * ── Why this is worth a build failure ──
 *
 * A NUL anywhere in a file makes `grep` and `ripgrep` classify it as binary and
 * skip it. Not "no matches with a warning" — no output at all, exit 0. The file
 * is simply invisible to every text search anybody runs over the repository,
 * including the ones a reviewer runs to decide whether a change is safe.
 *
 * Three files in the v1.2c release had one, and in every case the NUL was
 * *correct* as a runtime value — it is the right separator for a fingerprint or
 * a dedupe key, precisely because it cannot occur in the values being joined.
 * Only the encoding was wrong: a literal byte where the two-character escape
 * `\0` means exactly the same thing to the parser and leaves the file readable
 * by tooling.
 *
 *   server/errorReporter.js        the fingerprint separator
 *   server/errorReporter.test.js   a hostile route fixture, '/events\0'
 *   src/utils/errorReporting.js    the client dedupe key
 *
 * The damage is entirely outside the test suite, which is why nothing caught
 * them: `readFileSync` handles NUL perfectly, so every guard built on reading
 * source kept working while every guard built on searching it went quiet. The
 * release audit hit it directly — a search for whether the client reporter
 * touches `document.cookie` returned "binary file matches" rather than an
 * answer, and the plain-grep version of the same question would have returned
 * nothing at all and looked like a clean result.
 *
 * Checked as raw bytes rather than decoded text. Reading as UTF-8 and testing
 * for the escape would work too, but a Buffer asks the question the same way
 * the tools that break actually ask it.
 *
 * This guard caught itself on its first run: the paragraph above originally
 * contained a literal NUL, because describing the character is the one other
 * place somebody reaches for it. Comments are source too.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const ROOTS = ['src', 'server'];
const EXTENSIONS = /\.(js|jsx|ts|tsx|css|json|md)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'scratch', '.git']);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

describe('every source file stays searchable', () => {
  const files = ROOTS.flatMap((r) => collect(path.join(process.cwd(), r)));

  it('finds files at all, so this cannot pass vacuously', () => {
    expect(files.length, 'walked no source files — the collector is broken')
      .toBeGreaterThan(100);
  });

  it('contains no NUL byte, which would hide the file from grep and ripgrep', () => {
    const offenders = files
      .filter((f) => readFileSync(f).includes(0))
      .map((f) => path.relative(process.cwd(), f));

    expect(
      offenders,
      'these files are invisible to every text search, silently. The NUL is '
      + 'almost certainly right as a value — write it as the escape \\0 instead '
      + 'of a literal byte, which is identical at runtime and leaves the file '
      + 'readable by tooling.'
    ).toEqual([]);
  });
});
