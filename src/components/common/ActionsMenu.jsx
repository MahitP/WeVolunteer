import React, { useState, useEffect } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * A menu of actions behind one trigger.
 *
 * A `<menu>` of real buttons rather than a styled list, so keyboard and screen
 * reader users get the semantics for free. Escape and outside-click close it,
 * and focus returns to the trigger — the same contract `useModal` gives dialogs,
 * implemented here rather than reused because a popover that traps focus would
 * be wrong.
 *
 * ── Why this is shared rather than copied ──
 *
 * It began as a local component in `PublicProfile`. The organization roster then
 * needed the same thing, and a second copy of a menu that manages its own escape
 * handling, outside-click and ARIA wiring is a second copy that drifts — one of
 * them gets an accessibility fix and the other does not. There is one now.
 *
 * `icon` and `triggerClassName` exist because the two callers sit in different
 * places: the profile's is a three-dot overflow at the top of a page, the
 * roster's is a per-row control that has to read as "manage this person".
 */
export default function ActionsMenu({
  label,
  items,
  icon: Icon = MoreHorizontal,
  triggerClassName = 'btn btn-ghost btn-icon',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e) => { if (!e.target.closest('.profile-menu')) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open]);

  /* An empty menu renders no trigger at all. A button that opens nothing is
     worse than an absent one — it reads as broken rather than as unavailable. */
  if (!items || items.length === 0) return null;

  return (
    <div className="profile-menu">
      <button
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
      {open && (
        <menu className="profile-menu-list" role="menu">
          {items.map(item => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className={item.destructive ? 'profile-menu-item profile-menu-item-danger' : 'profile-menu-item'}
                onClick={() => { setOpen(false); item.onSelect(); }}
              >
                <item.icon size={15} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </menu>
      )}
    </div>
  );
}
