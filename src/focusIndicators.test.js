import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Every keyboard-operable control keeps a visible focus indicator, including in
 * forced-colors mode.
 *
 * ── The failure this exists to prevent ──
 *
 * `--focus` is a box-shadow by construction — `0 0 0 2px var(--surface), 0 0 0
 * 4px var(--brand)`, two rings — and the note at `.persona-option` says so while
 * explaining why `outline: 2px solid var(--focus)` would be invalid. So the
 * global rule replaced the outline with that shadow:
 *
 *     :focus { outline: none; }
 *     :focus-visible { outline: none; box-shadow: var(--focus); }
 *
 * Windows High Contrast Mode strips box-shadow. There was no
 * `@media (forced-colors: active)` block anywhere in 12,000+ lines of this
 * stylesheet, so in that mode the application had NO focus indicator at all, on
 * any control, on any page — a 2.4.7 failure aimed precisely at the people most
 * likely to be in that mode. Every declaration involved was individually
 * correct, which is why no existing guard could see it and why nobody caught it
 * in review: reviewing CSS in High Contrast is not a thing anybody does.
 *
 * `.composer-input` was worse and needed no special mode. It zeroed `outline`
 * AND `box-shadow` together, on both `:focus` and `:focus-visible`, so the
 * message composer was the one control in the application with no focus
 * indicator for anybody.
 *
 * ── Why the rule is stated generally ──
 *
 * The bug was not two bad declarations. It was that killing an outline and
 * restoring it were separate decisions nobody kept paired. So this asserts the
 * property rather than the instances: no focus rule may zero its outline and its
 * replacement together, and the stylesheet must carry a forced-colors block that
 * puts a real outline back.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { body }` pair, comments already stripped. */
function rules() {
  return [...CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
    .filter(r => r.selector && !r.selector.startsWith('@'));
}

const zeroesOutline = body => /outline\s*:\s*(none|0)\b/.test(body);
const paintsShadow = body => /box-shadow\s*:\s*(?!none)/.test(body);

describe('focus indicators', () => {
  it('read the stylesheet at all', () => {
    /* Guards the guard: an empty read makes every assertion below vacuous. */
    expect(CODE.length).toBeGreaterThan(100000);
  });

  it('never zeroes an outline and its replacement together', () => {
    const offenders = rules()
      .filter(r => /:focus/.test(r.selector))
      .filter(r => zeroesOutline(r.body) && /box-shadow\s*:\s*none/.test(r.body))
      .map(r => r.selector);
    expect(
      offenders,
      `these focus rules leave no visible indicator at all: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('gives the message composer a focus indicator', () => {
    /* The textarea legitimately drops its own outline — the visible border is on
       the form around it — so the indicator has to be findable on the wrapper. */
    const wrapper = rules().filter(r => /\.message-composer:focus-within/.test(r.selector));
    expect(wrapper.length, '.message-composer:focus-within has no rule — was the class renamed?')
      .toBeGreaterThan(0);
    expect(
      wrapper.some(r => paintsShadow(r.body)),
      '.message-composer:focus-within exists but paints no indicator'
    ).toBe(true);
  });

  it('restores a real outline in forced-colors mode', () => {
    const at = CODE.indexOf('@media (forced-colors: active)');
    expect(at, 'no @media (forced-colors: active) block — box-shadow focus rings vanish there')
      .toBeGreaterThan(-1);
    /* The block runs to the end of the file today; slicing from its start is
       enough to assert what it contains without parsing nested braces. */
    const body = CODE.slice(at);
    expect(body, 'the forced-colors block does not mention :focus-visible').toMatch(/:focus-visible/);
    expect(body, 'the forced-colors block declares no outline').toMatch(/outline\s*:\s*[^n]/);
    /* A system colour keyword, not a token: forced-colors repaints authored
       colours, so `var(--brand)` could be mapped to the background colour. */
    expect(body, 'use a system colour keyword (Highlight / CanvasText / LinkText / ButtonText)')
      .toMatch(/\b(Highlight|CanvasText|LinkText|ButtonText)\b/);
  });

  it('covers the controls that opt out of the global focus rule', () => {
    /* Each of these declares `outline: none` in its own rule, which the global
       forced-colors `:focus-visible` cannot reach through. A control added to
       that list without being added here is invisible again in High Contrast. */
    const optOuts = rules()
      .filter(r => /:focus/.test(r.selector) && zeroesOutline(r.body) && paintsShadow(r.body))
      .map(r => r.selector.replace(/:focus(-visible)?/g, '').trim());

    const forced = CODE.slice(CODE.indexOf('@media (forced-colors: active)'));
    const missing = [...new Set(optOuts)].filter(sel => sel && !forced.includes(sel));
    expect(
      missing,
      'these selectors replace the outline with a shadow but are not named in the '
      + `forced-colors block, so they have no indicator there: ${missing.join(', ')}`
    ).toEqual([]);
  });
});
