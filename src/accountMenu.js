import { Clock, Settings as SettingsIcon } from 'lucide-react';

/**
 * The destinations the account control offers, declared once.
 *
 * ── Why this file exists ──
 *
 * "The account control" is two different components at two widths, and that is
 * deliberate: `ProfileMenu` is the avatar menu at the foot of the desktop rail,
 * and the `⋯` mobile sheet is what replaces it on a phone, where there is no
 * avatar menu at all — the note on `accountOnly` in App.jsx's NAV table says so
 * explicitly.
 *
 * The two were assembled independently. `ProfileMenu` wrote out Profile,
 * Notifications, Settings and Sign Out in its own JSX; the sheet rendered the
 * SECONDARY nav entries and then wrote out Settings and Sign Out again in
 * App.jsx. Settings therefore already existed twice, in two files, with nothing
 * asserting they agreed.
 *
 * That went unnoticed while both lists were identical, and stopped being
 * survivable the moment one of them gained an entry. "My hours" was added to
 * `ProfileMenu` — and was measured in a browser at 375px afterwards, where the
 * sheet offered Notifications, Profile, Settings and Sign Out and no way to
 * reach a student's own service record at all. A destination that exists on a
 * laptop and not on a phone is the same class of fault as the rail/sheet drift
 * `navSectionsFor` was written to prevent, in the other direction.
 *
 * ── What is here and what is not ──
 *
 * Only the shared DESTINATIONS. Presentation stays with each surface, because
 * they genuinely differ — `menu-item` with a 15px icon in a popover, versus
 * `mobile-more-btn` with a 20px icon in a sheet that has to be dismissed. A
 * shared component would have to be told which of those it is, which is a
 * worse seam than a shared list.
 *
 * `Profile` and `Notifications` are NOT here. Both are declared in App.jsx's
 * NAV table (Profile as `secondary` + `accountOnly`, Notifications as
 * `secondary`), which is what puts them in the sheet already; duplicating them
 * would give the sheet each entry twice. `Sign Out` is not here either: it is
 * an action rather than a destination, it is the only item that is destructive,
 * and both surfaces style it apart for that reason.
 */
export const ACCOUNT_MENU_ITEMS = [
  /**
   * A student's own volunteering record.
   *
   * ── Why it is promoted, and why only this one ──
   *
   * The record lives across five destinations — `/hours`, `/certificates`,
   * `/portfolio`, `/profile/badges` and `/profile` — each with a documented
   * reason to exist, and none of them was in the rail or in either account
   * control. They hang off buttons on the dashboard and the profile, so a
   * student who had navigated away had to find the dashboard again before they
   * could answer "where is my volunteering history".
   *
   * `/hours` is the right one of the five to promote: it is the whole record,
   * WeVolunteer and self-reported together, and the other four are linked from
   * it or from the profile beside it. Promoting all five would move the problem
   * into the menu.
   *
   * NOT added to the navigation rail. The primary tier is capped at six on
   * purpose — the mobile bar draws every primary entry — and this is somewhere
   * people go to read rather than the next step in a task.
   *
   * `portfolio.write` is the capability `/hours` itself requires: students and
   * the owner hold it; organizers, administrators and partners do not. An
   * unconditional entry would offer three roles a page that answers 403, and a
   * menu item that appears and then refuses is worse than an absent one.
   */
  { id: 'hours', path: '/hours', label: 'My hours', icon: Clock, requiredCap: 'portfolio.write' },
  /**
   * Settings, which every role reaches and which therefore declares no
   * capability. `/settings` has no `requiredCap` in the route table either, and
   * `PAGE_META` fills it in for all four personas.
   */
  { id: 'settings', path: '/settings', label: 'Settings', icon: SettingsIcon },
];
