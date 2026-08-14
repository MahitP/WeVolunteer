import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The seam where server modules are pulled into the browser bundle.
 *
 * ── The bug this exists for ──
 *
 * `src/issueReports.js` re-exports `server/issueReports.js`, which imported
 * `server/emailIdentity.js`, whose first statement is
 * `export const MAIL_DOMAIN = process.env.MAIL_DOMAIN || …`.
 *
 * Under the dev server that module is served to the browser as written, and
 * `process` does not exist there. The read threw at IMPORT time, so
 * `/report-issue` never rendered at all — the crash boundary caught it and
 * showed "This page came off the board" on the one screen a student reaches
 * when everything else is already broken.
 *
 * ── Why nothing caught it ──
 *
 * Three independent gates were green:
 *
 *   • `npm test` — Vitest runs under Node, where `process` exists. Even a full
 *     render test of the page would have passed.
 *   • `npm run build` — the bundler rewrites `process.env` to `{}`, so the
 *     expression became `{}.MAIL_DOMAIN || 'wevolunteers.org'`. Valid JS, no
 *     error, and the configured domain silently replaced by the fallback.
 *   • `npm run lint` — `process` is a legal global in a Node project.
 *
 * The only thing that could see it was loading the page in a browser. That is
 * not a gate that runs on every commit, so this is.
 *
 * ── Why a source scan rather than an execution test ──
 *
 * Executing each module with `process` removed is the more direct proof, and it
 * is not available: Node's own ESM loader needs `process`, and stubbing it
 * globally inside Vitest breaks the runner rather than the module under test.
 * A `vm` context deep enough to resolve real imports would be a module loader.
 *
 * So this reads the source, which is enough because the failure is textual: a
 * Node global named at module scope. The set is computed transitively rather
 * than listed, so a new import three levels down is covered on the day it is
 * added and not on the day somebody remembers this file.
 */

const ROOT = process.cwd();

/** Node globals that do not exist in a browser and throw when read. */
const NODE_GLOBALS = ['process', '__dirname', '__filename'];

/**
 * Blanks comment lines so the scan cannot match prose.
 *
 * The same line-oriented approach as `authz.completeness.test.js`, and for the
 * reason recorded there: a regex that looks INSIDE a line for `/*` gets opened
 * by a string literal like `'https://*.tile.openstreetmap.org'` and swallows
 * everything up to the next accidental close. A line is blanked only when the
 * line itself begins with `//`, `/*` or `*`, which cannot misfire on real code
 * and keeps line numbers exact.
 *
 * This matters here specifically: the header of `server/issueReports.js` now
 * QUOTES `process.env.MAIL_DOMAIN` while explaining why it must not appear.
 * Without stripping, this file would fail on the comment that documents it.
 */
function stripComments(source) {
  return source.split('\n').map((line) => {
    const t = line.trim();
    return (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) ? '' : line;
  }).join('\n');
}

/** Every `server/…` module named by an import anywhere under `src/`. */
function entryPoints() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(jsx?|tsx?)$/.test(entry.name)) continue;
      /* Test files are excluded deliberately: they run under Node, so a test
         importing a server module directly is not this bug. */
      if (/\.test\./.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of stripComments(text).matchAll(/from\s+'((?:\.\.\/)+server\/[^']+)'/g)) {
        found.add(path.resolve(path.dirname(full), m[1]));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return found;
}

/** Those modules plus everything they import, transitively. */
function reachable() {
  const seen = new Set();
  const queue = [...entryPoints()];
  const missing = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) { missing.push(file); continue; }
    seen.add(file);
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  return { modules: seen, missing };
}

const rel = (f) => path.relative(ROOT, f);

describe('server modules that reach the browser', () => {
  const { modules, missing } = reachable();

  it('all resolve to files that exist', () => {
    expect(missing.map(rel)).toEqual([]);
  });

  it('there are some, so the cases below are not scanning an empty set', () => {
    /**
     * The control. Every assertion here is "none of them does X", which passes
     * trivially against nothing — and the walk depends on a relative-import
     * regex that a refactor to path aliases would quietly stop matching.
     */
    expect(modules.size).toBeGreaterThan(3);
  });

  it.each(NODE_GLOBALS)('never name `%s` at any depth', (global) => {
    const pattern = new RegExp(`\\b${global}\\b`);
    const offenders = [];

    for (const file of modules) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      text.split('\n').forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }

    expect(
      offenders,
      `These server modules are bundled into the browser, where \`${global}\` does not exist.\n`
      + 'Reading it at module scope throws on import and takes down the whole page — silently in\n'
      + 'the test suite and the build, because both run somewhere it is defined.\n'
      + 'Move the value behind a function the server calls, or keep it out of the shared module.\n\n'
      + offenders.join('\n')
    ).toEqual([]);
  });

  it('do not import a Node builtin for anything evaluated at module scope', () => {
    /**
     * `node:crypto` is allowed and present — the bundler replaces it with a stub
     * and the functions using it (`newReference`, `newIssueId`) are only ever
     * called on the server. What must not happen is CALLING into it while the
     * module is being evaluated, which no stub can satisfy.
     *
     * Detected as a top-level `const`/`let`/`var` initialised from a member call
     * on an imported builtin namespace, which is the shape that would run at
     * import time.
     */
    const offenders = [];
    for (const file of modules) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      const builtins = [...text.matchAll(/import\s+(\w+)\s+from\s+'node:[^']+'/g)].map(m => m[1]);
      for (const name of builtins) {
        const atTopLevel = new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+\\w+\\s*=\\s*${name}\\.`, 'm');
        if (atTopLevel.test(text)) offenders.push(`${rel(file)} calls ${name}.… at module scope`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the module that broke', () => {
  /**
   * Pinned by name as well as by the sweep above. The sweep is the general
   * guarantee; this is the specific one, so that a refactor which accidentally
   * drops `server/issueReports.js` out of the reachable set — by inlining the
   * re-export, say — does not also quietly drop its protection.
   */
  const shared = fs.readFileSync(path.join(ROOT, 'server', 'issueReports.js'), 'utf8');

  it('does not import the mail address book', () => {
    expect(
      /from\s+'\.\/emailIdentity\.js'/.test(stripComments(shared)),
      'server/issueReports.js imports emailIdentity.js again — that module reads '
      + 'process.env at module scope and this one is bundled into the browser'
    ).toBe(false);
  });

  it('still carries the routing key, so categories cannot lose their mailbox', () => {
    /* The address moved to the route; the KEY has to stay here, or a category
       added later has nowhere declared to send its replies. */
    expect(shared).toMatch(/replyToKeyFor/);
    expect(shared).toMatch(/replyTo: 'security'/);
  });
});
