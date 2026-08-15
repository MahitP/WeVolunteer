import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { UserPlus2, UserMinus, Ban } from 'lucide-react';
import ActionsMenu from './ActionsMenu';

/**
 * The row action menu.
 *
 * ── The bug this file exists for ──
 *
 * On the organization roster the menu was invisible. Not broken — invisible.
 * The state flipped, `aria-expanded` said `true`, the markup rendered, the
 * icons resolved, and nothing appeared on screen.
 *
 * `.list` sets `overflow: hidden`, correctly, to clip row backgrounds to its
 * rounded corners — in sixty-seven places. The menu was an absolutely
 * positioned child of a row inside that list, so it was clipped to whatever
 * fraction of it happened to fall inside. Measured on the real page: the menu
 * occupied y 2827–3024 and the list ended at 2836, leaving nine visible pixels.
 *
 * Every obvious suspect checks out when you chase that from the symptom, which
 * is why the fix is structural — a portal out of the subtree — and why the
 * structure is asserted here rather than only the behaviour. A test that just
 * clicked the trigger and looked for the items would have passed throughout the
 * entire time the menu was unusable, because jsdom does not clip.
 */

const items = [
  { id: 'promote', icon: UserPlus2, label: 'Promote to Student Organizer', onSelect: vi.fn() },
  { id: 'kick', icon: UserMinus, label: 'Remove from organization', onSelect: vi.fn() },
  { id: 'ban', icon: Ban, label: 'Ban from organization', destructive: true, onSelect: vi.fn() },
];

/** Renders the menu inside a clipping container, exactly as the roster does. */
function renderInClippingList(props = {}) {
  return render(
    <ul className="list" style={{ overflow: 'hidden' }}>
      <li>
        <ActionsMenu label="Manage Alex Thompson" items={items} {...props} />
      </li>
    </ul>
  );
}

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: /Manage Alex Thompson/i }));
  return screen.getByRole('menu');
};

describe('opening and closing', () => {
  it('opens on click and lists its actions', () => {
    renderInClippingList();
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([
      'Promote to Student Organizer',
      'Remove from organization',
      'Ban from organization',
    ]);
  });

  it('reports its state on the trigger', () => {
    renderInClippingList();
    const trigger = screen.getByRole('button', { name: /Manage Alex Thompson/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    renderInClippingList();
    const trigger = screen.getByRole('button', { name: /Manage Alex Thompson/i });
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    /* Otherwise Escape drops the caret at the top of the document and a
       keyboard user walks the whole page again to get back. */
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when a pointer goes down outside it', () => {
    renderInClippingList();
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open when the pointer goes down inside it', () => {
    /* The click-away has to test the MENU and the TRIGGER separately now that
       they are no longer in the same subtree — a single `closest` was enough
       while they shared a parent and silently stops being enough with a portal. */
    renderInClippingList();
    const menu = openMenu();
    fireEvent.mouseDown(menu);
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('runs the action and closes', () => {
    renderInClippingList();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Ban from organization/i }));
    expect(items[2].onSelect).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('it escapes its container', () => {
  it('renders outside the clipping list, not inside it', () => {
    /**
     * THE regression. A menu inside `.list` is clipped by that list's
     * `overflow: hidden` and is invisible on a real page while remaining
     * perfectly findable in jsdom — so this asserts the DOM position rather
     * than the appearance.
     */
    const { container } = renderInClippingList();
    const menu = openMenu();

    const list = container.querySelector('ul.list');
    expect(list, 'the fixture no longer builds a clipping container').not.toBeNull();
    expect(
      list.contains(menu),
      'the menu is inside the overflow:hidden list again — it will be clipped and invisible'
    ).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it('is positioned against the viewport, so no ancestor scroll can move it away', () => {
    renderInClippingList();
    const menu = openMenu();
    expect(menu.className).toMatch(/profile-menu-list-floating/);
  });
});

describe('what it refuses to render', () => {
  it('shows no trigger at all when there are no actions', () => {
    /* A button that opens nothing reads as broken rather than as unavailable —
       which matters here, because "no actions" is what an unauthorized viewer
       sees. */
    render(<ActionsMenu label="Manage nobody" items={[]} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('honours disabled', () => {
    renderInClippingList({ disabled: true });
    expect(screen.getByRole('button', { name: /Manage Alex Thompson/i })).toBeDisabled();
  });
});

describe('keyboard navigation', () => {
  it('moves between items with the arrow keys', () => {
    renderInClippingList();
    const menu = openMenu();
    const entries = within(menu).getAllByRole('menuitem');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(entries[1]);
    /* Wraps, so a keyboard user never hits a dead end at either end. */
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(entries[entries.length - 1]);
  });
});
