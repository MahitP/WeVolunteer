import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AREAS } from './views/ModerationCenter.jsx';
import { PAGE_META, tabForPath } from './App.jsx';
import { DESTINATIONS } from './ai/navigation.js';

/**
 * The owner's names, everywhere (ruling 5, defect A10).
 *
 * ── What was wrong ──
 *
 * The administrative hub had three names: "Admin" on the rail and in its title,
 * "Moderation Center" when Welly offered to open it, and tiles that named the
 * pages behind them differently from the pages themselves — "Administrators"
 * opened a page titled "Administrator roster", which Welly called "Administrator
 * Roster"; "Audit trail" opened "Audit Explorer". A reader who clicks one name
 * and arrives under another wonders whether they arrived.
 *
 * The owner named these pages himself (FX-07): Community Impact, Appeals, Admin
 * Roster, Audit Explorer, Errors, Platform Impact. And he ruled (2026-09-30)
 * that his words win everywhere: "Discover" for every "Browse/Find
 * opportunities" label and for the organizer's page title, which was
 * "Recruit"; "Organizations" for the button that opens `/organizations`.
 */

const OWNER_NAMES = {
  '/impact': 'Community Impact',
  '/admin/appeals': 'Appeals',
  '/admin/roster': 'Admin Roster',
  '/admin/audit-logs': 'Audit Explorer',
  '/errors': 'Errors',
  '/admin/impact': 'Platform Impact',
};

describe('one name for each administrative page', () => {
  it.each(Object.entries(OWNER_NAMES))('%s is "%s" on its hub tile, in its title and to Welly', (to, name) => {
    expect(AREAS.find(a => a.to === to)?.title, 'hub tile').toBe(name);
    expect(PAGE_META.staff[tabForPath(to)]?.title, 'page title').toBe(name);
    for (const d of Object.values(DESTINATIONS).filter(x => x.path === to)) {
      expect(d.label, 'Welly').toBe(name);
    }
  });

  it('has Welly call the hub what the rail calls it', () => {
    const hub = Object.values(DESTINATIONS).find(d => d.path === '/admin/moderation');
    expect(hub.label).toBe(PAGE_META.staff[tabForPath('/admin/moderation')].title);
    expect(hub.label).toBe('Admin');
  });
});

describe('"Discover", never "Browse" or "Find opportunities"', () => {
  it('titles the page Discover for every persona that has it', () => {
    for (const persona of ['volunteer', 'host', 'staff']) {
      const meta = PAGE_META[persona].browse;
      if (meta) expect(meta.title, persona).toBe('Discover');
    }
  });

  it('labels every link to /discover with the page\'s name', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.jsx$/.test(entry.name) && !/\.test\.jsx$/.test(entry.name)) files.push(p);
      }
    };
    walk(path.join(process.cwd(), 'src'));

    const offenders = [];
    for (const file of files) {
      const flat = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
      for (const m of flat.matchAll(/<Link[^>]*to="\/discover"[^>]*>(.*?)<\/Link>/g)) {
        const label = m[1].replace(/<[^>]*>/g, '').trim();
        if (/\b(browse|find)\b/i.test(label)) offenders.push(`${path.relative(process.cwd(), file)}: "${label}"`);
      }
      for (const m of flat.matchAll(/<button[^>]*setActiveTab\('browse'\)[^>]*>(.*?)<\/button>/g)) {
        const label = m[1].replace(/<[^>]*>/g, '').trim();
        if (/\b(browse|find)\b/i.test(label)) offenders.push(`${path.relative(process.cwd(), file)}: "${label}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has Welly call it Discover, and Organizations what the button says', () => {
    expect(Object.values(DESTINATIONS).find(d => d.path === '/discover')?.label).toBe('Discover');
    expect(Object.values(DESTINATIONS).find(d => d.path === '/organizations')?.label).toBe('Organizations');
  });
});
