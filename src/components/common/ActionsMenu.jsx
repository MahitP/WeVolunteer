import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

/**
 * A menu of actions behind one trigger.
 *
 * ── Why it renders through a portal ──
 *
 * It used to be an absolutely-positioned element inside the trigger's own
 * wrapper, and on the organization roster that made it invisible. `.list` sets
 * `overflow: hidden` — correctly, to clip row backgrounds to its rounded
 * corners, in sixty-seven places — so a popover positioned below the last row
 * was clipped to the nine pixels that happened to fall inside the list.
 *
 * Measured on the roster before this was rewritten: the menu rendered at
 * y 2827–3024 inside a `UL.list.org-members` whose bottom edge was 2836. The
 * markup was right, the state was right, `aria-expanded` said `true`, and
 * nothing appeared. That is the worst kind of bug to chase from the symptom,
 * because every obvious suspect — the click handler, the state, the icons —
 * checks out.
 *
 * The fix cannot be `overflow: visible` on `.list`: that clipping is what keeps
 * row backgrounds inside the border radius everywhere else. So the menu leaves
 * the subtree entirely. A portal into `document.body` with `position: fixed`
 * has no clipping ancestor by construction, and it fixes the same latent bug
 * anywhere else this component is dropped inside a scroll container.
 *
 * ── Why fixed rather than absolute ──
 *
 * Portaled into `body`, `absolute` would be positioned against the document and
 * drift on scroll. `fixed` is positioned against the viewport, which is where
 * the trigger's `getBoundingClientRect()` already is — so the two agree without
 * bookkeeping, and a scroll simply recomputes.
 */
export default function ActionsMenu({
  label,
  items,
  icon: Icon = MoreHorizontal,
  triggerClassName = 'btn btn-ghost btn-icon',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  /**
   * Where the menu goes, in viewport coordinates.
   *
   * Right-aligned to the trigger, because the trigger sits at the end of a row.
   * Flipped above when there is not room below, and clamped to the viewport so
   * a menu near the right edge cannot push the page sideways — at 320px the
   * menu is nearly as wide as the screen, which is exactly where an unclamped
   * `left` becomes horizontal overflow.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const t = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const width = menu?.offsetWidth || 240;
    const height = menu?.offsetHeight || 0;
    const gap = 6;
    const margin = 8;

    let left = t.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    const below = window.innerHeight - t.bottom;
    const flip = height > 0 && below < height + gap && t.top > below;
    const top = flip ? Math.max(margin, t.top - height - gap) : t.bottom + gap;

    setPos({ top, left });
  }, []);

  /* Placed once the menu exists so its real size is known, then kept in step
     with scrolling and resizing. `capture` catches scrolls in any ancestor, not
     only the window. */
  useEffect(() => {
    if (!open) { setPos(null); return undefined; }
    place();
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        /* Focus goes back where it came from — otherwise Escape drops the
           caret at the top of the document and a keyboard user has to walk the
           whole page again. */
        triggerRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const focusable = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
        if (!focusable.length) return;
        const i = focusable.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown'
          ? focusable[(i + 1) % focusable.length]
          : focusable[(i - 1 + focusable.length) % focusable.length];
        next.focus();
      }
    };

    /**
     * Click-away.
     *
     * The menu is no longer a descendant of the trigger's wrapper, so "is the
     * click inside the menu" has to test BOTH nodes explicitly — a `closest`
     * on one container was enough when they shared a parent and silently stops
     * being enough the moment a portal is involved.
     */
    const onClick = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('touchstart', onClick);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('touchstart', onClick);
    };
  }, [open]);

  /* An empty menu renders no trigger at all. A button that opens nothing reads
     as broken rather than as unavailable. */
  if (!items || items.length === 0) return null;

  const menu = open && (
    <menu
      ref={menuRef}
      className="profile-menu-list profile-menu-list-floating"
      role="menu"
      aria-label={label}
      style={pos ? { top: `${pos.top}px`, left: `${pos.left}px` } : { visibility: 'hidden' }}
    >
      {items.map(item => (
        <li key={item.id} role="none">
          <button
            type="button"
            role="menuitem"
            className={item.destructive ? 'profile-menu-item profile-menu-item-danger' : 'profile-menu-item'}
            onClick={() => { setOpen(false); triggerRef.current?.focus(); item.onSelect(); }}
          >
            <item.icon size={15} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        </li>
      ))}
    </menu>
  );

  return (
    <div className="profile-menu">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
      {/* Into `body`, so no ancestor's `overflow` can clip it. */}
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
