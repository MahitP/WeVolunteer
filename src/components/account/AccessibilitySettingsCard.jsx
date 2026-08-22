import React from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Flag, RotateCcw } from 'lucide-react';
import { useAccessibilityPreferences, DEFAULTS } from '../../hooks/useAccessibilityPreferences';

/**
 * Settings → Accessibility.
 *
 * ── What is deliberately NOT here ──
 *
 * There is no "enable keyboard navigation", no "screen reader mode", no "enable
 * accessible buttons". Those would mean the application ships inaccessible by
 * default with a hidden repair, and a person who needs them would have to find
 * this page — using the interface that does not yet work for them — before they
 * could use anything. Keyboard operation, focus indicators, semantic structure,
 * accessible names, reflow and the system's reduced-motion preference are
 * unconditional. Everything on this page is personalisation on top of that, and
 * the note at the bottom says so in as many words, because a reader who arrives
 * here looking for the switch that makes the app work deserves to be told
 * plainly that there isn't one and doesn't need to be.
 *
 * ── Native controls, on purpose ──
 *
 * A real `<fieldset>`/`<legend>` with radios for the one multi-value choice, and
 * real checkboxes in labels for the switches — the same pattern the Privacy
 * section already uses. A `<div role="radiogroup">` with hand-rolled arrow keys
 * is more code that behaves worse: the browser already gives radios group
 * navigation, a group name from the legend, and the selected state announced on
 * arrival. The point of an accessibility settings page is not to demonstrate
 * ARIA.
 */

const TEXT_SIZES = [
  { value: 'default', label: 'Default', hint: 'The standard size.' },
  { value: 'large', label: 'Large', hint: 'About one eighth larger.' },
  { value: 'x-large', label: 'Extra large', hint: 'About one quarter larger.' }
];

/**
 * Each switch, its stored values, and copy that says what actually changes.
 *
 * The description is the part that matters. "High contrast: on" tells somebody
 * nothing about whether it will help them; "increases the contrast of text and
 * borders" lets them decide before they try it, which is the difference between
 * a setting and a guess.
 */
const SWITCHES = [
  {
    key: 'contrast',
    on: 'high',
    label: 'Increase contrast',
    hint: 'Darkens body text and strengthens borders, keeping WeVolunteer’s colours. '
      + 'If you use your operating system’s own high-contrast mode, that is applied '
      + 'automatically and you do not need this.'
  },
  {
    key: 'motion',
    on: 'reduce',
    label: 'Reduce motion',
    hint: 'Removes animations and transitions. If your device already asks for reduced '
      + 'motion, WeVolunteer honours that on its own — this is for when it does not, '
      + 'or when you want less movement only here.'
  },
  {
    key: 'transparency',
    on: 'reduce',
    label: 'Reduce transparency',
    hint: 'Makes the top bar, menus and dialog backgrounds solid instead of blurred.'
  },
  {
    key: 'controls',
    on: 'large',
    label: 'Larger controls',
    hint: 'Gives buttons and inputs a bigger target on every device. Touchscreens already '
      + 'get this; a mouse or trackpad does not unless you ask.'
  },
  {
    key: 'linkUnderlines',
    on: 'always',
    label: 'Always underline links',
    hint: 'Underlines links in text so they are not identified by colour alone. '
      + 'Navigation and buttons are left alone.'
  }
];

export default function AccessibilitySettingsCard() {
  const [prefs, setPreference, reset] = useAccessibilityPreferences();
  const isDefault = Object.entries(DEFAULTS).every(([k, v]) => prefs[k] === v);

  return (
    <>
      <div className="card card-pad">
        <h3 style={{ marginBottom: 'var(--s2)' }}>Display</h3>
        <p className="dim" style={{ marginBottom: 'var(--s4)' }}>
          These apply on this device only, so a shared computer keeps its own settings.
        </p>

        {/* A real fieldset: the legend names the group, and the browser announces
            "Text size, Large, 2 of 3" without any ARIA at all. */}
        <fieldset className="a11y-fieldset">
          <legend className="strong">Text size</legend>
          <div className="stack-xs" style={{ marginTop: 'var(--s2)' }}>
            {TEXT_SIZES.map(({ value, label, hint }) => (
              <label className="row" key={value} style={{ alignItems: 'flex-start' }}>
                <input
                  type="radio"
                  name="a11y-text-size"
                  value={value}
                  checked={prefs.textSize === value}
                  onChange={() => setPreference('textSize', value)}
                />
                <div className="stack-xs" style={{ flex: 1 }}>
                  <span className="strong">{label}</span>
                  <span className="dim small">{hint}</span>
                </div>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
        <h3 style={{ marginBottom: 'var(--s4)' }}>Interaction</h3>
        <div className="stack-md">
          {SWITCHES.map(({ key, on, label, hint }) => (
            <label className="row" key={key} style={{ alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={prefs[key] === on}
                onChange={e => setPreference(key, e.target.checked ? on : DEFAULTS[key])}
              />
              <div className="stack-xs" style={{ flex: 1 }}>
                <span className="strong">{label}</span>
                <span className="dim small">{hint}</span>
              </div>
            </label>
          ))}
        </div>

        {!isDefault && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 'var(--s4)' }}
            onClick={reset}
          >
            <RotateCcw size={14} aria-hidden="true" /> Reset to defaults
          </button>
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
        <h3 style={{ marginBottom: 'var(--s2)' }}>About accessibility here</h3>
        {/**
          * The honest framing, and the reason this paragraph is not marketing.
          *
          * Somebody opening this page may be looking for the setting that makes
          * WeVolunteer usable. Telling them there isn't one — because the things
          * they need are already on — is more useful than a list of features,
          * and it stops them hunting for a switch that does not exist.
          */}
        <p className="dim" style={{ marginBottom: 'var(--s3)' }}>
          Keyboard navigation, screen-reader support, browser zoom and your device&rsquo;s
          reduced-motion setting all work in WeVolunteer without being switched on. The
          settings above are extras, not requirements.
        </p>
        <div className="stack-xs">
          <Link to="/legal/accessibility-statement" className="row">
            <ExternalLink size={14} aria-hidden="true" />
            <span>Accessibility Statement</span>
          </Link>
          {/**
            * Deep-linked to the accessibility category, which
            * server/issueReports.js already defines. A person blocked by a
            * barrier should not have to find the right option in a dropdown
            * using the interface that is failing them.
            */}
          <Link to="/report-issue?category=accessibility" className="row">
            <Flag size={14} aria-hidden="true" />
            <span>Report an accessibility issue</span>
          </Link>
        </div>
      </div>
    </>
  );
}
