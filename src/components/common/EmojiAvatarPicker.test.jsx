import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import EmojiAvatarPicker from './EmojiAvatarPicker';
import { AVATAR_COLOR_KEYS, isAvatarColor, avatarColorValue } from '../../utils/avatarColors';

/**
 * Choosing an emoji and a colour.
 *
 * The property that matters most here is that two picks in a row both survive —
 * see the stale-closure test. It is the defect this component actually shipped
 * with, and it was found by clicking two controls in one frame in a browser
 * rather than by any assertion.
 */

/** A host that merges patches the way the real editors do. */
function Host({ onState }) {
  const [value, setValue] = useState({ emoji: null, color: null });
  onState?.(value);
  return (
    <EmojiAvatarPicker
      emoji={value.emoji}
      color={value.color}
      onChange={patch => setValue(v => ({ ...v, ...patch }))}
    />
  );
}

const emojiButton = (glyph) =>
  [...document.querySelectorAll('.emoji-option')].find(b => b.textContent.trim() === glyph);

describe('picking', () => {
  it('keeps both when an emoji and a colour are chosen in turn', () => {
    /**
     * The integration shape, for intent. It does NOT reproduce the original
     * defect: `fireEvent` is act-wrapped, so React commits between the two
     * clicks and the handlers are rebuilt from fresh props. In a browser the
     * two clicks shared one frame and the second wrote the first's stale
     * partner back.
     *
     * The test below is the one that actually holds the contract — it asserts
     * each handler sends ONLY its own field, which is what makes the frame
     * sharing harmless. Kept apart deliberately rather than merged, so nobody
     * reads this one as proof of the fix.
     */
    let latest;
    render(<Host onState={v => { latest = v; }} />);

    fireEvent.click(emojiButton('⚽'));
    fireEvent.click(document.querySelectorAll('.emoji-colour')[1]);

    expect(latest.emoji).toBe('⚽');
    expect(latest.color).toBe(AVATAR_COLOR_KEYS[1]);
  });

  it('sends ONLY the field that changed — the contract that fixes the frame race', () => {
    /**
     * The real regression test.
     *
     * `pick` used to send `{ emoji: next, color }` and `paint`
     * `{ emoji, color: next }`, each reading the other from its render closure.
     * Two clicks in one frame therefore came from one closure and the second
     * reverted the first. Sending a patch makes the merge the caller's job,
     * where the current value lives, and makes the frame sharing irrelevant.
     */
    const onChange = vi.fn();
    render(<EmojiAvatarPicker emoji="🏀" color="sage" onChange={onChange} />);

    fireEvent.click(emojiButton('⚽'));
    expect(onChange).toHaveBeenCalledWith({ emoji: '⚽' });

    onChange.mockClear();
    fireEvent.click(document.querySelectorAll('.emoji-colour')[0]);
    expect(onChange).toHaveBeenCalledWith({ color: 'sage' });
  });

  it('clears both together', () => {
    const onChange = vi.fn();
    render(<EmojiAvatarPicker emoji="⚽" color="sky" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith({ emoji: null, color: null });
  });
});

describe('search', () => {
  it('finds by the word somebody would type, not the Unicode name', () => {
    /* ⚽ is officially "soccer ball"; a generated index finds nothing for
       "football" against it. The keywords are written for that reason. */
    render(<Host />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'football' } });

    const shown = [...document.querySelectorAll('.emoji-option')].map(b => b.textContent.trim());
    expect(shown).toContain('⚽');
  });

  it('says so when nothing matches', () => {
    render(<Host />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'zzzzz' } });
    expect(screen.getByText(/No icons match/)).toBeInTheDocument();
  });

  it('restores the groups when the search is cleared', () => {
    render(<Host />);
    const box = screen.getByPlaceholderText(/search/i);
    fireEvent.change(box, { target: { value: 'football' } });
    fireEvent.change(box, { target: { value: '' } });

    expect(document.querySelectorAll('.emoji-group-name').length).toBeGreaterThan(4);
  });
});

describe('accessibility', () => {
  it('is a radiogroup, so the choices are arrow-navigable', () => {
    render(<Host />);
    const groups = screen.getAllByRole('radiogroup');
    expect(groups.length).toBeGreaterThanOrEqual(2); // icons and colours
  });

  it('gives every emoji an accessible name', () => {
    render(<Host />);
    for (const b of [...document.querySelectorAll('.emoji-option')].slice(0, 10)) {
      expect(b.getAttribute('aria-label')).toMatch(/^Use /);
    }
  });

  it('names each colour rather than relying on the swatch alone', () => {
    /* A colour with no name is unreachable for anybody not looking at it. */
    render(<Host />);
    for (const b of document.querySelectorAll('.emoji-colour')) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.getAttribute('title')).toBeTruthy();
    }
  });

  it('marks the current choice with aria-checked', () => {
    render(<EmojiAvatarPicker emoji="⚽" color="sky" onChange={vi.fn()} />);
    expect(emojiButton('⚽').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.emoji-colour.is-selected')).toBeTruthy();
  });
});

describe('the palette', () => {
  it('accepts only its own keys', () => {
    /* `avatar_color` is interpolated into a style attribute on every surface
       that draws a person. A key cannot be anything else; free text can. */
    for (const k of AVATAR_COLOR_KEYS) expect(isAvatarColor(k)).toBe(true);
    expect(isAvatarColor(null), 'null clears the choice').toBe(true);
    expect(isAvatarColor('#ff0000')).toBe(false);
    expect(isAvatarColor('red; background: url(x)')).toBe(false);
    expect(isAvatarColor('nonsense')).toBe(false);
  });

  it('resolves keys to CSS tokens rather than hex literals', () => {
    /* The values live in the stylesheet so the palette can be retuned for dark
       mode without a data migration. */
    for (const k of AVATAR_COLOR_KEYS) expect(avatarColorValue(k)).toMatch(/^var\(--avatar-/);
  });

  it('returns null for an unknown key instead of a broken style', () => {
    expect(avatarColorValue('chartreuse')).toBeNull();
    expect(avatarColorValue(null)).toBeNull();
  });
});
