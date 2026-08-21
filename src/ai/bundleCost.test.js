import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The on-device AI runtime carries a 7.7 MB WebAssembly binary. A build with
 * `VITE_LOCAL_AI` unset must not contain it, and the mechanism that guarantees
 * that is fragile in a specific way: it holds only while every path to the
 * runtime goes through a single dynamic import inside a branch the bundler can
 * prove is dead.
 *
 * One static `import` of the runtime anywhere in `src/` destroys it silently.
 * There is no error, no warning, and no visible symptom — every student simply
 * downloads eight megabytes more than before, which is the kind of regression
 * that is noticed months later on somebody's phone bill.
 *
 * ── Why this is a source scan and not a build comparison ──
 *
 * The property worth asserting is "the built output is unchanged when the flag
 * is off", and the honest way to check it is to build twice and diff. That
 * takes about a minute, and this repository's testing philosophy rests on a
 * suite fast enough to run before every push — a suite people skip prevents
 * nothing.
 *
 * So the split is deliberate: this test runs on every push and catches the
 * regression that actually happens, which is somebody adding an import. The
 * build comparison lives in `bin/verify-ai-bundle.mjs` and belongs to the
 * release checklist, where a minute is affordable and where the toolchain risk
 * it covers — Vite issue #22362, dynamic imports containing top-level await
 * surviving tree-shaking — actually needs re-checking against a new Vite.
 */

/** Every .js/.jsx file under src/, excluding tests. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.jsx?$/.test(entry) && !/\.test\.jsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

const FILES = sourceFiles().map(file => ({
  path: path.relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

/** Block and line comments removed, so prose about a package is not a use of it. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('on-device AI bundle cost', () => {
  /**
   * The modules permitted to reach the package at all. Every one lives under
   * `runtime/` and is reached only through a guarded dynamic import in
   * `ai/index.js`. Adding to this list is a deliberate act that should require
   * reading why it exists.
   *
   * `opfsBackend.js` is here because wllama's default cache writes to
   * cross-origin storage, which this origin does not have — so a cache manager
   * has to be constructed explicitly wherever the library would otherwise
   * default one. It imports `CacheManager` for that and nothing else.
   */
  const RUNTIME_MODULES = [
    'ai/runtime/WllamaRuntime.js',
    'ai/runtime/storage.js',
    'ai/runtime/opfsBackend.js',
  ];

  it('names the package in only the two runtime modules', () => {
    /**
     * Deliberately matches ANY mention, not only a static `import` statement.
     * `storage.js` reaches the package through a dynamic import whose specifier
     * is a const, which no import-statement pattern would catch — and a
     * dynamic import in an unguarded module re-attaches the chunk just as
     * effectively as a static one.
     */
    const offenders = FILES
      .filter(f => f.text.includes('@wllama/wllama'))
      .map(f => f.path)
      .sort();

    expect(offenders).toEqual([...RUNTIME_MODULES].sort());
  });

  it('reaches each runtime module from exactly one place', () => {
    /**
     * `src/ai/index.js` guards both imports with the build-time flag, which is
     * what lets the bundler drop the branches. A second importer elsewhere
     * would almost certainly not be guarded.
     */
    const importersOf = pattern => FILES
      .filter(f => pattern.test(f.text))
      .map(f => f.path);

    expect(importersOf(/import\s*\(\s*['"][^'"]*WllamaRuntime/)).toEqual(['ai/index.js']);
    expect(importersOf(/import\s*\(\s*['"]\.\/runtime\/storage\.js['"]/)).toEqual(['ai/index.js']);
  });

  it('guards the import with the raw env literal, not the imported constant', () => {
    /**
     * This is the load-bearing line of the whole feature, and it was measured
     * rather than reasoned about.
     *
     * The obvious form — `import { LOCAL_AI } from '../config.js'` and then
     * `if (LOCAL_AI) { await import(...) }` — DOES NOT WORK. Measured against
     * Vite 8.1 on 2026-08-15, with the flag unset:
     *
     *   guarded by the imported constant …… 10,144 KB of assets
     *   guarded by import.meta.env directly … 2,652 KB of assets
     *
     * Both builds were otherwise identical. The constant version emitted the
     * runtime chunk AND the 7.66 MB `wllama.wasm` into a build with on-device
     * AI switched off — 7.5 MB shipped to every student, silently, for a
     * feature they could not use.
     *
     * The cause is that eliminating the branch requires folding a value across
     * a module boundary, whereas `import.meta.env.VITE_LOCAL_AI` is replaced
     * with a literal during transform and folds locally. This is the shape of
     * the known vitejs/vite issue 22362, and the reason the plan made this
     * measurement a gate rather than an assumption.
     *
     * `LOCAL_AI` from config.js is still correct everywhere else — screens use
     * it to decide what to render. It is only at this one import boundary that
     * the raw literal is required.
     */
    const entry = FILES.find(f => f.path === 'ai/index.js').text;

    /* The window is `[\s\S]{0,200}?` rather than `[^}]*` because the statement
       between the brace and the import destructures — `const { WllamaRuntime }`
       — so a pattern excluding `}` stops before ever reaching the import. */
    expect(entry).toMatch(
      /if\s*\(\s*import\.meta\.env\.VITE_LOCAL_AI\s*===\s*'true'\s*\)\s*\{[\s\S]{0,200}?import\s*\(\s*['"]\.\/runtime\/WllamaRuntime\.js['"]\s*\)/,
    );

    /* Both guarded imports, not just the first. The storage helpers pull in the
       same package, so an unguarded one would re-attach it. */
    expect(entry).toMatch(
      /if\s*\(\s*import\.meta\.env\.VITE_LOCAL_AI\s*===\s*'true'\s*\)\s*\{[\s\S]{0,200}?import\s*\(\s*['"]\.\/runtime\/storage\.js['"]\s*\)/,
    );
  });

  it('keeps the PDF parser behind a dynamic import too', () => {
    /**
     * `pdfjs-dist` is over a megabyte and is only reachable from the
     * certificate reader, which is itself behind the flag. A static import of
     * it anywhere would put it in every build, including ones where nobody can
     * open the control that uses it.
     */
    const statics = FILES
      .filter(f => /^\s*import[^\n(]*['"]pdfjs-dist/m.test(f.text))
      .map(f => f.path);
    expect(statics).toEqual([]);

    /* Comments are stripped before the reachability scan, following
       `tooling.scriptSafety.test.js`: these modules document at length why the
       parser is loaded the way it is, and the prose names the very package
       being searched for. */
    const mentions = FILES
      .filter(f => stripComments(f.text).includes('pdfjs-dist'))
      .map(f => f.path);
    expect(mentions).toEqual(['ai/certificate/extract.js']);
  });

  it('does not let the WebAssembly asset in through any other module', () => {
    const offenders = FILES
      .filter(f => /wllama\.wasm/.test(f.text))
      .map(f => f.path);

    expect(offenders).toEqual(['ai/runtime/WllamaRuntime.js']);
  });

  it('keeps everything the app imports directly free of the runtime', () => {
    /**
     * The modules re-exported from `ai/index.js` are imported by ordinary
     * screens, so they must stay cheap. If one of them grew a dependency on the
     * runtime, the guarded import would stop being the only path.
     */
    const cheap = ['ai/models.js', 'ai/capability.js', 'ai/integrity.js', 'ai/runtime/types.js'];

    for (const name of cheap) {
      const file = FILES.find(f => f.path === name);
      expect(file, `${name} should exist`).toBeTruthy();
      expect(file.text, name).not.toMatch(/@wllama/);
      expect(file.text, name).not.toMatch(/WllamaRuntime/);
    }
  });
});
