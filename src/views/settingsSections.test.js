import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Settings navigation and the Settings renderer must agree.
 *
 * ── The failure this exists to prevent ──
 *
 * Settings has two hand-maintained lists of its sections, in different files,
 * with nothing connecting them:
 *
 *   - `SECTIONS` in src/components/account/SettingsSidebar.jsx — what the
 *     navigation offers.
 *   - the `switch (activeSection)` in src/views/Settings.jsx — what actually
 *     renders.
 *
 * Add to one and forget the other and the failure is silent in both directions.
 * A sidebar entry with no case renders an EMPTY PANEL: the rail highlights, the
 * URL changes, and the page is blank — indistinguishable from a loading bug, and
 * worse for a screen-reader user, who gets no heading and no content and no
 * error to explain either. A case with no sidebar entry is a section reachable
 * only by typing `?section=` by hand, which in practice means unreachable.
 *
 * This is the same class of defect src/pageTitleCoverage.test.js was written
 * for — two sources of truth about routes drifting apart — and the same fix:
 * derive both from the files and compare them, so a section added tomorrow is
 * checked the day it is added rather than the day somebody remembers.
 */
const SIDEBAR = fs.readFileSync(
  path.join(process.cwd(), 'src/components/account/SettingsSidebar.jsx'), 'utf8'
);
const SETTINGS = fs.readFileSync(
  path.join(process.cwd(), 'src/views/Settings.jsx'), 'utf8'
);

/** Section ids the navigation offers, from the `SECTIONS` array literal. */
function sidebarIds() {
  const block = SIDEBAR.match(/const SECTIONS = \[([\s\S]*?)\n\];/);
  if (!block) return [];
  return [...block[1].matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]);
}

/** Section ids the renderer handles, from its switch's case labels. */
function renderedIds() {
  return [...SETTINGS.matchAll(/^\s*case '([^']+)':/gm)].map(m => m[1]);
}

describe('Settings sections', () => {
  it('found both lists at all', () => {
    /* Guards the guard: a renamed array or a switch rewritten as a lookup table
       would make every assertion below pass against two empty lists. */
    expect(sidebarIds().length, 'no SECTIONS array found in SettingsSidebar.jsx')
      .toBeGreaterThan(3);
    expect(renderedIds().length, 'no case labels found in Settings.jsx')
      .toBeGreaterThan(3);
  });

  it('offers no section the renderer cannot render', () => {
    const missing = sidebarIds().filter(id => !renderedIds().includes(id));
    expect(
      missing,
      `these sections are in the navigation but have no case, so selecting them `
      + `renders an empty panel: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('renders no section the navigation cannot reach', () => {
    const orphaned = renderedIds().filter(id => !sidebarIds().includes(id));
    expect(
      orphaned,
      `these sections render but are not in the navigation, so they are reachable `
      + `only by typing ?section= by hand: ${orphaned.join(', ')}`
    ).toEqual([]);
  });
});
