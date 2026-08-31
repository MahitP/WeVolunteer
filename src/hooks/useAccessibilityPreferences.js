import { useState, useEffect, useCallback } from 'react';

/**
 * The optional accessibility preferences, and the line they must not cross.
 *
 * ── What belongs here, and what emphatically does not ──
 *
 * Nothing in this file is required for WeVolunteer to be accessible. Keyboard
 * operation, focus indicators, semantic structure, accessible names, reflow and
 * respecting the operating system's reduced-motion setting are all
 * unconditional, and a preference that switched any of them ON would mean the
 * application shipped inaccessible by default with a hidden repair. These six
 * are personalisation: a person who already has what they need can ignore every
 * one of them.
 *
 * ── Why the OS is the default and this can only add ──
 *
 * `motion: 'system'` means "whatever `prefers-reduced-motion` says", which is
 * already honoured in eight places in index.css. The stored value can only
 * escalate to `reduce`; there is deliberately no way to say "animate anyway"
 * against a system preference that asked for less. Somebody who set that
 * preference on their device set it for a reason, and a site-level override
 * would let one careless tap undo it.
 *
 * ── Device-local, like the theme ──
 *
 * `localStorage`, not the account. Mirrors src/hooks/useTheme.js because these
 * settings describe a DEVICE — the phone with the small screen, the shared
 * library machine at high contrast — and syncing them would push one device's
 * needs onto another. `public/a11y-prefs.js` reads the same keys before first
 * paint, for the same reason `public/theme.js` exists: text size and contrast
 * applied after hydration are a visible flash of the wrong interface, which is
 * worst for exactly the person who needed the setting.
 *
 * If these ever need to follow an account, the pattern is a migration plus
 * `formatUserResponse` in server/utils.js plus the writable-field allowlist in
 * server/routes/userRoutes.js — see how `analyticsConsent` is wired.
 */

export const STORAGE_KEY = 'wevol-a11y';

/** Every preference, its allowed values, and the attribute it writes. */
export const PREFERENCES = Object.freeze({
  textSize: { values: ['default', 'large', 'x-large'], attribute: 'data-text-size' },
  contrast: { values: ['default', 'high'], attribute: 'data-contrast' },
  motion: { values: ['system', 'reduce'], attribute: 'data-motion' },
  transparency: { values: ['default', 'reduce'], attribute: 'data-transparency' },
  controls: { values: ['default', 'large'], attribute: 'data-controls' },
  linkUnderlines: { values: ['default', 'always'], attribute: 'data-link-underlines' }
});

export const DEFAULTS = Object.freeze({
  textSize: 'default',
  contrast: 'default',
  motion: 'system',
  transparency: 'default',
  controls: 'default',
  linkUnderlines: 'default'
});

/**
 * Stored preferences, with anything unrecognised discarded.
 *
 * A value is validated against its own allowed list rather than merely being
 * truthy. `localStorage` is writable by anything running on the origin and
 * survives across releases, so a key removed in a later version — or a typo
 * written by hand — would otherwise end up in a `data-` attribute and select a
 * CSS rule that no longer exists, which fails silently and looks like the
 * setting simply not working.
 */
export function readPreferences(storage = safeStorage()) {
  const out = { ...DEFAULTS };
  if (!storage) return out;
  let raw;
  try {
    raw = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, spec] of Object.entries(PREFERENCES)) {
    if (spec.values.includes(raw[key])) out[key] = raw[key];
  }
  return out;
}

/** Writes the `data-` attributes the stylesheet keys off, on `<html>`. */
export function applyPreferences(prefs, root = documentElement()) {
  if (!root) return;
  for (const [key, spec] of Object.entries(PREFERENCES)) {
    const value = prefs[key] ?? DEFAULTS[key];
    /* A default writes NO attribute rather than `data-x="default"`, so the
       stylesheet's base rules stay the ones with no attribute selector and the
       specificity of an unset preference is zero. */
    if (value === DEFAULTS[key]) root.removeAttribute(spec.attribute);
    else root.setAttribute(spec.attribute, value);
  }
}

function safeStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    /* Storage access throws outright in some privacy modes. Preferences are a
       convenience; refusing to render the app over one is not a trade worth
       making. */
    return null;
  }
}

function documentElement() {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * The preferences, and a setter that persists and applies in one step.
 *
 * Returns `[prefs, setPreference, reset]`. `setPreference` rejects a value not
 * in the preference's own list, so a caller cannot write a state the stylesheet
 * has no rule for.
 */
export function useAccessibilityPreferences() {
  const [prefs, setPrefs] = useState(() => readPreferences());

  useEffect(() => {
    applyPreferences(prefs);
  }, [prefs]);

  const setPreference = useCallback((key, value) => {
    const spec = PREFERENCES[key];
    if (!spec || !spec.values.includes(value)) return;
    setPrefs(current => {
      const next = { ...current, [key]: value };
      const storage = safeStorage();
      if (storage) {
        try {
          /* Only non-defaults are stored. A stored object full of "default"
             would make a future change to DEFAULTS silently not apply to
             anybody who had ever opened this page. */
          const persisted = Object.fromEntries(
            Object.entries(next).filter(([k, v]) => v !== DEFAULTS[k])
          );
          if (Object.keys(persisted).length === 0) storage.removeItem(STORAGE_KEY);
          else storage.setItem(STORAGE_KEY, JSON.stringify(persisted));
        } catch { /* full or blocked storage: the setting still applies for this session */ }
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    const storage = safeStorage();
    if (storage) {
      try { storage.removeItem(STORAGE_KEY); } catch { /* nothing to undo */ }
    }
    setPrefs({ ...DEFAULTS });
  }, []);

  return [prefs, setPreference, reset];
}
