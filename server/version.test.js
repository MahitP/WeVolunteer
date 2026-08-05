/**
 * The version must be the same number everywhere it is written down.
 *
 * ── Why this is a build-failing guard ──
 *
 * A half-applied bump is invisible. Nothing breaks, every test passes, and the
 * damage only shows up at the moment you most need the number to be true:
 *
 *   - `/health` reads **`server/package.json`**, not the root. Bumping only the
 *     root produces a build that reports a stale version during an incident,
 *     when `/health` is how you identify what is running. That exact failure
 *     happened before 1.1.0, when all three files read `1.0.0` while the branch
 *     carried the entire v1.1 codebase.
 *   - `error_groups.release` is stamped on every captured error from the same
 *     file. A stale value does not merely mislead — it makes the column
 *     useless, because two releases become indistinguishable in the one field
 *     that exists to tell them apart. v1.2a, v1.2b and v1.2c all recorded
 *     `1.1.0` until the v1.2c final release review caught it.
 *
 * The release process says to run one command that updates all five fields
 * (ENGINEERING_GUIDE §4.1). This is what notices when somebody edits a manifest
 * by hand instead, which is the realistic way it goes wrong.
 *
 * ── Why the CHANGELOG is checked too ──
 *
 * The manifests agreeing with each other is not enough: they can agree on a
 * number the release notes never mention. `CHANGELOG.md` is where an operator
 * looks up what a deployed version contains, so a heading that does not exist
 * for the shipped version is the same defect one layer out.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const read = (...p) => readFileSync(path.join(repoRoot, ...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));

/** The one that actually reaches users: `/health` and `error_groups.release`. */
const SERVED_VERSION = json('server', 'package.json').version;

describe('the version is consistent everywhere it is recorded', () => {
  it('agrees across both manifests and all three lockfile fields', () => {
    const lock = json('package-lock.json');

    // Named individually rather than collected into a set, so a failure says
    // WHICH file is stale instead of "these differ".
    const fields = {
      'server/package.json (this is what /health and error_groups.release report)': SERVED_VERSION,
      'package.json': json('package.json').version,
      'package-lock.json → version': lock.version,
      'package-lock.json → packages[""]': lock.packages[''].version,
      'package-lock.json → packages["server"]': lock.packages.server.version,
    };

    const disagreeing = Object.entries(fields).filter(([, v]) => v !== SERVED_VERSION);

    expect(
      Object.fromEntries(disagreeing),
      `these do not match server/package.json (${SERVED_VERSION}). Do not edit `
      + 'them by hand — one command updates all five:\n'
      + '  npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root'
    ).toEqual({});
  });

  it('is a plain semver triple, so /health stays machine-readable', () => {
    expect(SERVED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * Asserted on the HEADING, not on a bare substring search.
   *
   * `1.2.0` appears in a changelog for all sorts of reasons — a dependency
   * bump, a link, a sentence about some other project's version. Only a
   * `## [1.2.0]` heading means "this release is described here", which is the
   * claim being checked.
   */
  it('has a CHANGELOG section of its own', () => {
    const changelog = read('CHANGELOG.md');
    const headings = [...changelog.matchAll(/^##\s*\[([^\]]+)\]/gm)].map(m => m[1]);

    expect(
      headings,
      `CHANGELOG.md has no "## [${SERVED_VERSION}]" heading, so the running `
      + 'version describes itself nowhere. Found: ' + JSON.stringify(headings.slice(0, 8))
    ).toContain(SERVED_VERSION);
  });
});
