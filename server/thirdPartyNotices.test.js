import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every dependency copied to a browser is recorded in THIRD-PARTY-NOTICES.md.
 *
 * ── Why this is a build-failing guard ──
 *
 * Same reason as `envDocumentation.test.js`, which does this for rate limits: a
 * licence obligation nobody knows about cannot be discharged, and nothing breaks
 * when it is missed. Adding a client dependency is a one-line change that
 * silently creates an attribution duty, and the only thing that reliably catches
 * it is a test that reads the manifest and the document and compares them.
 *
 * The review that produced this file found two things a licence scan would have
 * caught years earlier: `react-leaflet` is under the Hippocratic License 2.1
 * rather than MIT — a licence with use conditions and a notice clause that
 * terminates on 30 days' uncured notice — and llama.cpp/ggml is compiled into
 * wllama's `.wasm` as a git submodule, so it is the largest binary shipped to a
 * browser and appears in no npm tree at all.
 *
 * ── What this does NOT check ──
 *
 * Whether the notices actually reach a user. They currently do not: the bundle
 * ships no licence banners at all. That is recorded as an open item in the
 * document, deliberately, because fixing it means adding product surface and
 * that is the owner's call. A test cannot make that decision, and one that
 * pretended to would be asserting a policy nobody agreed to.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

const NOTICES = readFileSync(path.join(repoRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/**
 * Root dependencies that are NOT copied to a browser.
 *
 * The root manifest is mostly the client bundle, but not entirely — these two
 * are required here and used only by the server, so no copy reaches a user and
 * no notice is owed. Listed with the reason rather than filtered by a pattern,
 * because "does this end up in the bundle" is not derivable from the name.
 */
const SERVER_ONLY = Object.freeze({
  pg: 'PostgreSQL driver. Server-side only; the browser never sees it.',
  'socket.io': 'The server half. The client half is socket.io-client, which IS listed.',
});

describe('third-party notices', () => {
  it('records every client-shipped dependency', () => {
    const undocumented = Object.keys(manifest.dependencies ?? {})
      .filter(name => !(name in SERVER_ONLY))
      .filter(name => !NOTICES.includes(name));

    expect(
      undocumented,
      'These are copied to every visitor\'s browser and are named in no notice. '
      + 'Add each to THIRD-PARTY-NOTICES.md with its version, licence and the '
      + 'copyright line from its own LICENSE file — not from its package.json, '
      + 'which carries an SPDX id and no attribution. If a dependency is in fact '
      + 'server-only, add it to SERVER_ONLY here with the reason.'
    ).toEqual([]);
  });

  it('still names the component no npm tool can find', () => {
    /* llama.cpp/ggml is a git submodule of wllama, compiled into its .wasm. If
       a future edit tidies this file by regenerating it from the dependency
       tree, this line is what fails — which is the whole point, because a
       generated list cannot contain it. */
    expect(NOTICES).toMatch(/llama\.cpp/);
    expect(NOTICES).toMatch(/ggml/);
  });

  it('still flags the dependency that is not under a permissive licence', () => {
    /* react-leaflet's Hippocratic-2.1 terms are the one thing in here that a
       district's procurement might refuse. Losing that sentence would turn this
       document back into a list of MIT packages, which is the impression it
       existed to correct. */
    expect(NOTICES).toMatch(/Hippocratic/);
  });

  it('does not claim the notices are delivered', () => {
    /**
     * The document has to keep saying it is incomplete for as long as it is.
     *
     * The failure mode this guards is the specific one this project warns about
     * elsewhere: a file that reads as compliance while the bundle ships nothing.
     * If somebody discharges the obligation for real — a `/licenses` route, or
     * banners restored in the build — they should remove the open item AND this
     * assertion, in the same change, having checked that `dist/` actually
     * carries the notices.
     */
    expect(NOTICES).toMatch(/Status: incomplete as shipped/);
  });
});
