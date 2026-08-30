(function () {
  /**
   * Accessibility preferences, applied before the first paint.
   *
   * The same arrangement as theme.js, for the same reason and with the same
   * duplication. A text-size or contrast preference applied after React mounts
   * is a visible flash of the interface the person explicitly said they could
   * not use — worst for exactly the reader who needed the setting. So the
   * attributes are written here, synchronously, from the same localStorage key
   * src/hooks/useAccessibilityPreferences.js owns.
   *
   * Kept deliberately dumb: no imports, no bundler, no shared module. This file
   * runs before any JavaScript module has loaded, which is the whole point, so
   * the validation is a hand-written whitelist. If a preference is added, it has
   * to be added in both places — and the guard test
   * src/accessibilityPreferences.test.js fails when the two lists disagree,
   * because a preference that works only after hydration is the bug this file
   * exists to prevent.
   */
  var ALLOWED = {
    textSize: { values: ['large', 'x-large'], attribute: 'data-text-size' },
    contrast: { values: ['high'], attribute: 'data-contrast' },
    motion: { values: ['reduce'], attribute: 'data-motion' },
    transparency: { values: ['reduce'], attribute: 'data-transparency' },
    controls: { values: ['large'], attribute: 'data-controls' },
    linkUnderlines: { values: ['always'], attribute: 'data-link-underlines' }
  };

  try {
    var stored = JSON.parse(localStorage.getItem('wevol-a11y') || '{}');
    if (!stored || typeof stored !== 'object') return;
    var root = document.documentElement;
    for (var key in ALLOWED) {
      if (!Object.prototype.hasOwnProperty.call(ALLOWED, key)) continue;
      var spec = ALLOWED[key];
      if (spec.values.indexOf(stored[key]) !== -1) {
        root.setAttribute(spec.attribute, stored[key]);
      }
    }
  } catch (e) {
    /* Unparseable or blocked storage means no preferences. The application is
       accessible without them; that is the entire design. */
  }
})();
