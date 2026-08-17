import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a student gets when the build has no Welly.
 *
 * ── This is no longer the default, and that is the point ──
 *
 * Welly used to be opt-in: `VITE_LOCAL_AI` unset meant no assistant, so this
 * file described what almost everybody was running. It is now ON by default
 * (see the `define` block in vite.config.js and the note beside it), because a
 * feature reachable only by knowing an undocumented variable is a feature that
 * is off in every deployment where somebody forgot — invisibly, with no error.
 *
 * The opted-out path still exists, still ships none of the 9.4 MB, and is still
 * what `npm run dev:no-ai` and `VITE_LOCAL_AI=false` produce. So it still needs
 * a test — what changed is that it can no longer be exercised by simply not
 * setting anything, and these assertions have to say so explicitly.
 *
 * ── Why `isLocalAIEnabled` is mocked rather than the env stubbed ──
 *
 * `vi.stubEnv` cannot reach this. `define` substitutes the flag textually during
 * transform, so by the time a test runs, `import.meta.env.VITE_LOCAL_AI === 'true'`
 * has already become `'true' === 'true'` in the emitted source — there is no
 * lookup left to stub. That is precisely the property that lets the bundler drop
 * the runtime, so it is not a limitation to work around; it is the mechanism
 * working.
 *
 * Every surface gates on `isLocalAIEnabled()`, which is the seam the feature
 * actually has, and mocking it is how the enabled-path suites already do the
 * reverse (see AISettingsCard.test.jsx). Asserting through the real seam is also
 * a stronger test than asserting through a stubbed global: it fails if somebody
 * adds a surface that reads the flag some other way.
 */

vi.mock('./index.js', async importOriginal => ({
  ...(await importOriginal()),
  isLocalAIEnabled: () => false,
}));

vi.mock('../../ai', async () => {
  const real = await import('./index.js');
  return { ...real, isLocalAIEnabled: () => false };
});

const AssistantLauncher = (await import('../components/ai/AssistantLauncher.jsx')).default;
const AISettingsCard = (await import('../components/account/AISettingsCard.jsx')).default;
const CertificateImport = (await import('../components/account/CertificateImport.jsx')).default;
const TagSuggestions = (await import('../components/common/TagSuggestions.jsx')).default;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeEach(() => {
  window.localStorage.clear();
});

describe('a build that opted out of on-device AI', () => {
  it('renders no launcher in the topbar', () => {
    const { container } = render(<MemoryRouter><AssistantLauncher /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /welly/i })).toBeNull();
  });

  it('renders no settings panel', () => {
    const { container } = render(<MemoryRouter><AISettingsCard /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders no certificate import control', () => {
    const { container } = render(<MemoryRouter><CertificateImport /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders no tag suggestion control', () => {
    const { container } = render(
      <MemoryRouter><TagSuggestions title="x" description="y" /></MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing even for somebody whose stored preferences say it is on', () => {
    /**
     * The case that matters most. Somebody who enabled Welly, then received a
     * build without it, must not get a broken control — the preference is
     * device-local and outlives the flag.
     */
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, modelId: 'qwen2.5-0.5b-instruct-q4km' }),
    );

    const { container } = render(<MemoryRouter><AssistantLauncher /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the default points at ON, and both directions are reachable', () => {
  it('defaults the flag to "true" in vite.config.js', () => {
    /**
     * The assertion that would have caught the original complaint — "Welly is
     * implemented and verified and I still cannot see it after `npm run dev`".
     * The default has to be visible in a committed file, because the whole
     * failure was that it lived in one nobody commits.
     */
    const config = readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
    expect(config).toMatch(/process\.env\.VITE_LOCAL_AI\s*\?\?[\s\S]{0,80}?\?\?\s*'true'/);
    expect(config).toContain("'import.meta.env.VITE_LOCAL_AI'");
  });

  it('does not make plain `dev` depend on the variable', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    /* The point of the change: no flag in the ordinary command, and Welly still
       there. A `dev` script that sets it would work but would put the default
       back in a place a deployment does not read. */
    expect(pkg.scripts.dev).not.toContain('VITE_LOCAL_AI');
  });

  it('offers an explicit way to run each path', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['dev:no-ai']).toContain('VITE_LOCAL_AI=false');
    expect(pkg.scripts['build:no-ai']).toContain('VITE_LOCAL_AI=false');
    /* Kept for the muscle memory of anyone who learned it, and because being
       explicit about ON stays meaningful if the default ever moves again. */
    expect(pkg.scripts['dev:ai']).toContain('VITE_LOCAL_AI=true');
  });

  it('documents the default as on, and says where it lives', () => {
    const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    /* Still present and still empty — an operator reading this file has to be
       able to see the switch exists without having to read vite.config.js. */
    expect(example).toMatch(/^VITE_LOCAL_AI=\s*$/m);
    expect(example).toMatch(/ON BY DEFAULT/);
    expect(example).toContain('npm run dev:no-ai');
  });
});
