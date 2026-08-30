import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PREFERENCES, DEFAULTS, STORAGE_KEY, readPreferences, applyPreferences } from './hooks/useAccessibilityPreferences';

/**
 * The three places a preference has to be declared must agree.
 *
 * A preference lives in three files by necessity, not by accident:
 *
 *   1. src/hooks/useAccessibilityPreferences.js — the state React owns.
 *   2. public/a11y-prefs.js — the same read, run before the first paint, with no
 *      bundler and no imports available to it. That duplication is the whole
 *      point: a text-size or contrast preference applied after hydration is a
 *      visible flash of the interface the reader said they could not use.
 *   3. src/index.css — the `:root[data-*]` rules that make the attribute do
 *      something.
 *
 * Every way these can drift fails silently and looks identical to "the setting
 * is broken":
 *
 *   - In the hook but not the pre-paint script: works, but only after the page
 *     has already painted wrong once. The reader sees the flash every single
 *     load, which is worst for the person who needed the setting most.
 *   - In either script but not the CSS: the attribute lands on <html> and
 *     nothing changes. The toggle moves and the interface does not.
 *   - A value allowed by one and not the other: the setting works in one code
 *     path and not the other, which is the hardest kind of bug to be told about
 *     usefully.
 *
 * So all three are derived and compared, and none of them is a list maintained
 * here.
 */
const PREPAINT = fs.readFileSync(path.join(process.cwd(), 'public/a11y-prefs.js'), 'utf8');
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

/** The pre-paint script's whitelist, parsed from its ALLOWED literal. */
function prepaintSpec() {
  const block = PREPAINT.match(/var ALLOWED = \{([\s\S]*?)\n {2}\};/);
  if (!block) return {};
  const out = {};
  const entry = /(\w+):\s*\{\s*values:\s*\[([^\]]*)\],\s*attribute:\s*'([^']+)'/g;
  for (const m of block[1].matchAll(entry)) {
    out[m[1]] = {
      values: [...m[2].matchAll(/'([^']+)'/g)].map(v => v[1]),
      attribute: m[3]
    };
  }
  return out;
}

const PREPAINT_SPEC = prepaintSpec();

describe('accessibility preferences', () => {
  it('parsed the pre-paint script at all', () => {
    /* Guards the guard: a renamed ALLOWED object would make every comparison
       below pass against an empty spec. */
    expect(Object.keys(PREPAINT_SPEC).length, 'no ALLOWED map found in public/a11y-prefs.js')
      .toBeGreaterThan(3);
  });

  it('is loaded before the first paint', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    /* In <head> and not deferred: after the paint is the bug, not the fix. */
    expect(html, 'index.html does not load /a11y-prefs.js').toContain('/a11y-prefs.js');
    const tag = html.match(/<script[^>]*a11y-prefs\.js[^>]*>/)[0];
    expect(tag, 'the pre-paint script must not be deferred or async').not.toMatch(/defer|async|type="module"/);
  });

  it('declares the same preferences in the hook and the pre-paint script', () => {
    const inHook = Object.keys(PREFERENCES).sort();
    const inScript = Object.keys(PREPAINT_SPEC).sort();
    expect(
      inScript,
      'a preference in one but not the other either flashes on every load or does not persist'
    ).toEqual(inHook);
  });

  it('writes the same attribute name from both', () => {
    for (const [key, spec] of Object.entries(PREFERENCES)) {
      expect(PREPAINT_SPEC[key]?.attribute, `${key} writes a different attribute pre-paint`)
        .toBe(spec.attribute);
    }
  });

  it('accepts the same non-default values in both', () => {
    for (const [key, spec] of Object.entries(PREFERENCES)) {
      /* The pre-paint script deliberately lists only NON-default values: a
         default writes no attribute, so there is nothing for it to apply. */
      const nonDefault = spec.values.filter(v => v !== DEFAULTS[key]).sort();
      expect(PREPAINT_SPEC[key]?.values.slice().sort(), `${key} allows different values pre-paint`)
        .toEqual(nonDefault);
    }
  });

  it('has a stylesheet rule for every non-default value', () => {
    const missing = [];
    for (const [key, spec] of Object.entries(PREFERENCES)) {
      for (const value of spec.values) {
        if (value === DEFAULTS[key]) continue;
        const selector = `[${spec.attribute}='${value}']`;
        if (!CSS.includes(selector)) missing.push(`${key}=${value} (expected ${selector})`);
      }
    }
    expect(
      missing,
      'these preferences write an attribute the stylesheet never reacts to, so the '
      + `toggle moves and nothing changes: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('every default is one of its own allowed values', () => {
    for (const [key, spec] of Object.entries(PREFERENCES)) {
      expect(spec.values, `${key}'s default is not in its own value list`).toContain(DEFAULTS[key]);
    }
  });

  it('offers no way to override a system reduced-motion preference', () => {
    /* Somebody who told their operating system they want less motion asked for a
       reason, and a site-level "animate anyway" would let one careless tap undo
       it. The only non-default value may escalate. */
    expect(PREFERENCES.motion.values).toEqual(['system', 'reduce']);
  });

  it('discards a stored value it does not recognise', () => {
    /* localStorage is writable by anything on the origin and survives releases,
       so a removed key or a hand-typed typo would otherwise reach a data-
       attribute and select a rule that no longer exists — failing silently and
       looking exactly like the setting not working. */
    const store = new Map([[STORAGE_KEY, JSON.stringify({
      textSize: 'gigantic', contrast: 'high', nonsense: 'x'
    })]]);
    const fake = { getItem: k => store.get(k) ?? null };
    const prefs = readPreferences(fake);
    expect(prefs.textSize).toBe(DEFAULTS.textSize);
    expect(prefs.contrast).toBe('high');
    expect(prefs.nonsense).toBeUndefined();
  });

  it('survives storage that throws, rather than failing to render', () => {
    const hostile = { getItem() { throw new Error('blocked'); } };
    expect(() => readPreferences(hostile)).not.toThrow();
    expect(readPreferences(hostile)).toEqual(DEFAULTS);
  });

  it('writes no attribute for a default, so base rules keep zero specificity', () => {
    const attrs = new Map();
    const root = {
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: k => attrs.delete(k)
    };
    applyPreferences({ ...DEFAULTS }, root);
    expect([...attrs.keys()]).toEqual([]);

    applyPreferences({ ...DEFAULTS, textSize: 'large' }, root);
    expect([...attrs.entries()]).toEqual([['data-text-size', 'large']]);
  });
});
