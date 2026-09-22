import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotificationsBell from './NotificationsBell';
import { groupNotifications } from '../utils/notifications';
import { api } from '../utils/api';

/**
 * Where a notification click GOES.
 *
 * ── Why this is worth a file of its own ──
 *
 * `ece14c6` made an `event:<id>` link resolve against the server instead of
 * only against two local caches, which is what stopped
 * `FRIEND_SIGNED_UP` and `ORGANIZATION_EVENT_POSTED` answering "That event is
 * no longer available" for a live event. That fix is covered at the seam
 * (`utils/resolveEvent.test.js`) and at the shell (`App.eventDeepLink.test.jsx`).
 *
 * Neither covers the step in front of both: the three lines that decide an
 * `event:` link goes to `onViewEvent` with the BARE ID and a `/` link goes to
 * the router. Change `split(':')[1]` to `split(':')[0]`, or hand `onViewEvent`
 * the whole link, and every notification click breaks while both of those
 * suites stay green.
 *
 * ── And why the duplication matters ──
 *
 * `views/Notifications.jsx` and `components/NotificationsBell.jsx` carry that
 * handler BYTE-FOR-BYTE. This audit has already found several defects whose
 * shape was "the guard was applied to one half of a duplicated pair", so the
 * contract is asserted here and the duplication is asserted as source text —
 * cheaper and more honest than mounting the full page, which needs a session,
 * a router and a dozen mocks to exercise three lines.
 *
 * Link SHAPES are not invented here. Every link the server emits is either
 * `event:<id>` or `/`-prefixed: `notificationContent.js` builds the rest as
 * literals, and the three that pass `payload.link` through are
 * `/messages?conversation=…` (messageRoutes) and `/settings…` (exportWorker,
 * twice), with the default arm falling back to `/settings`.
 */

vi.mock('../utils/api');
vi.mock('../services/socket', () => ({
  subscribeSocket: vi.fn(() => () => {}),
  getSocket: vi.fn(() => null),
}));

const NOTIF = (over = {}) => ({
  id: 'n1', kind: 'VOLUNTEER', priority: 'LOW', read: false,
  title: 'A friend signed up', body: 'There may still be places.',
  createdAt: new Date().toISOString(), link: 'event:event-riverbank', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.markNotificationsRead.mockResolvedValue({});
});

function openBell({ notifications, onViewEvent = vi.fn() }) {
  api.fetchNotifications.mockResolvedValue({ unreadCount: 1, notifications });
  render(
    <MemoryRouter><NotificationsBell onViewEvent={onViewEvent} onSeeAll={vi.fn()} /></MemoryRouter>
  );
  return { onViewEvent };
}

describe('an event notification', () => {
  it('hands onViewEvent the bare id, not the whole link', async () => {
    const { onViewEvent } = openBell({ notifications: [NOTIF()] });

    fireEvent.click(await screen.findByRole('button', { name: /notifications/i }));
    fireEvent.click(await screen.findByText('A friend signed up'));

    await waitFor(() => expect(onViewEvent).toHaveBeenCalledWith('event-riverbank'));
    /* The failure this pins: passing `event:event-riverbank` through would make
       `openEventById` look up an id that cannot exist, and the notification
       would report the event as gone — the exact defect ece14c6 fixed one
       layer down. */
    expect(onViewEvent).not.toHaveBeenCalledWith('event:event-riverbank');
  });
});

describe('the two copies of the handler', () => {
  /**
   * A source check, deliberately. The behaviour above is asserted once against
   * the component that is cheap to mount; this is what stops the other copy
   * drifting away from it.
   */
  const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('still dispatch an event link identically', () => {
    const bell = read('src/components/NotificationsBell.jsx');
    const page = read('src/views/Notifications.jsx');
    const DISPATCH = "if (n.link?.startsWith('event:')) onViewEvent?.(n.link.split(':')[1]);";

    expect(bell, 'the bell stopped extracting the bare id').toContain(DISPATCH);
    expect(page, 'the notifications page stopped extracting the bare id').toContain(DISPATCH);
  });

  it('still send a path link to the router identically', () => {
    const PATH = "else if (n.link?.startsWith('/')) navigate(n.link);";
    expect(read('src/components/NotificationsBell.jsx')).toContain(PATH);
    expect(read('src/views/Notifications.jsx')).toContain(PATH);
  });
});

describe('grouping keeps a notification clickable', () => {
  /**
   * `groupNotifications` had no tests at all, and both components route the
   * GROUPED object rather than the original. The group is built with
   * `{...item}`, so `link` survives — but nothing said so, and a group that
   * lost its link would be a click that silently does nothing.
   */
  const evt = (id, over = {}) => NOTIF({
    id, kind: 'EVENT', link: 'event:event-riverbank',
    title: 'Event details changed', body: 'Details changed: time.', ...over,
  });

  it('carries the link onto the combined item', () => {
    const [group] = groupNotifications([evt('a'), evt('b')]);
    expect(group.isGroup).toBe(true);
    expect(group.link).toBe('event:event-riverbank');
  });

  it('carries every id it absorbed, so the group can be marked read', () => {
    /* Both handlers do `n.originalItems.map(i => i.id)` when `isGroup`. */
    const [group] = groupNotifications([evt('a'), evt('b')]);
    expect(group.originalItems.map(i => i.id).sort()).toEqual(['a', 'b']);
  });

  it('leaves a lone notification exactly as it was', () => {
    const one = evt('a');
    expect(groupNotifications([one])).toEqual([one]);
  });

  it('does not group a critical notice into a summary', () => {
    /* `priority !== 'CRITICAL'` on both sides of the match — an urgent notice
       must keep its own row rather than being folded into "2 new updates". */
    const grouped = groupNotifications([evt('a', { priority: 'CRITICAL' }), evt('b', { priority: 'CRITICAL' })]);
    expect(grouped.every(n => !n.isGroup)).toBe(true);
  });
});
