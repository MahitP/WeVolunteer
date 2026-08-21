import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readPreferences,
  writePreferences,
  clearPreferences,
  DEFAULT_PREFERENCES,
} from './preferences.js';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defaults', () => {
  it('is entirely off before anybody chooses anything', () => {
    /**
     * The property that matters most here. A student who has never opened these
     * settings must have no model, no download and no assistant — nothing in
     * this feature is opt-out.
     */
    expect(readPreferences()).toEqual({
      enabled: false,
      modelId: null,
      saveConversations: false,
      voiceInput: false,
    });
  });

  it('keeps voice separate from the main switch', () => {
    /* Voice may send audio to the browser vendor, so it cannot ride along on
       the switch that turns on the on-device parts. */
    const prefs = writePreferences({ enabled: true, modelId: 'x' });
    expect(prefs.voiceInput).toBe(false);
  });

  it('does not let a caller mutate the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_PREFERENCES)).toBe(true);

    const prefs = readPreferences();
    prefs.enabled = true;
    expect(readPreferences().enabled).toBe(false);
  });
});

describe('writing', () => {
  it('merges a change over what was already stored', () => {
    writePreferences({ enabled: true, modelId: 'fast-model' });
    const after = writePreferences({ saveConversations: true });

    expect(after).toEqual({
      enabled: true,
      modelId: 'fast-model',
      saveConversations: true,
      voiceInput: false,
    });
  });

  it('returns what was stored, so callers can set state from it', () => {
    expect(writePreferences({ enabled: true }).enabled).toBe(true);
    expect(readPreferences().enabled).toBe(true);
  });
});

describe('reading hostile or stale values', () => {
  it('ignores a stored property the code does not know about', () => {
    /* Read field by field rather than spread, so a stale build's key or a
       hand-edited value cannot introduce a property nothing expects. */
    window.localStorage.setItem(
      'wev-ai-prefs',
      JSON.stringify({ enabled: true, rogue: 'value', modelId: 'm' }),
    );

    expect(readPreferences()).toEqual({
      enabled: true,
      modelId: 'm',
      saveConversations: false,
      voiceInput: false,
    });
  });

  it('treats a non-boolean as off rather than as truthy', () => {
    window.localStorage.setItem('wev-ai-prefs', JSON.stringify({ enabled: 'yes' }));
    expect(readPreferences().enabled).toBe(false);
  });

  it('rejects a non-string model id', () => {
    window.localStorage.setItem('wev-ai-prefs', JSON.stringify({ modelId: 42 }));
    expect(readPreferences().modelId).toBeNull();
  });

  it('falls back to defaults on unparseable storage', () => {
    window.localStorage.setItem('wev-ai-prefs', 'not json{');
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('falls back to defaults when the stored value is not an object', () => {
    window.localStorage.setItem('wev-ai-prefs', '"a string"');
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });
});

describe('when storage is unavailable', () => {
  it('reads defaults instead of throwing', () => {
    /**
     * Safari in private mode throws on access rather than returning null.
     * Settings failing to render because storage is unavailable would be far
     * worse than falling back to the defaults.
     */
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied');
    });

    expect(() => readPreferences()).not.toThrow();
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('accepts a write that cannot be persisted', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota');
    });

    /* The setting holds for this session and is forgotten on reload. Refusing
       the change outright would be worse. */
    expect(() => writePreferences({ enabled: true })).not.toThrow();
    expect(writePreferences({ enabled: true }).enabled).toBe(true);
  });

  it('clears without throwing', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied');
    });
    expect(() => clearPreferences()).not.toThrow();
  });
});

describe('clearing', () => {
  it('returns to the defaults', () => {
    writePreferences({ enabled: true, modelId: 'm', saveConversations: true });
    clearPreferences();
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('leaves every other key on this device alone', () => {
    /**
     * "Clear AI data" must not take the theme, the cached user, or a draft
     * attendance sheet with it. Downloaded models and verification records are
     * removed by their own explicit steps.
     */
    window.localStorage.setItem('wevol-theme', 'dark');
    window.localStorage.setItem('wev_auth_user', '{"id":1}');
    window.localStorage.setItem('wev_draft_attendance_e1', '{}');

    writePreferences({ enabled: true });
    clearPreferences();

    expect(window.localStorage.getItem('wevol-theme')).toBe('dark');
    expect(window.localStorage.getItem('wev_auth_user')).toBe('{"id":1}');
    expect(window.localStorage.getItem('wev_draft_attendance_e1')).toBe('{}');
  });
});
