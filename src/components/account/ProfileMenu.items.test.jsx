import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProfileMenu from './ProfileMenu';

const STUDENT = {
  id: 'user-student-9', name: 'Alice Rivera', username: 'alice_rivera',
  role: 'student', verified: true, withheld: [], grants: [],
};

function Where() { return <output data-testid="where">{useLocation().pathname + useLocation().search}</output>; }

const open = (user = STUDENT) => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <ProfileMenu user={user} onEditProfile={vi.fn()} onSignOut={vi.fn()} />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>
  );
  fireEvent.click(document.querySelector('.userchip'));
};

/**
 * The owner's words, twice (FX-17, FX-21): clicking your name shows
 *     Profile / Notifications / Settings / Sign Out
 * and nothing else. A student's menu had a fifth item, "My hours" — ruled out
 * by the owner on 2026-09-30 (ruling 3); the dashboard carries that entry.
 */
describe('the account menu', () => {
  it('is exactly Profile, Notifications, Settings, Sign Out — for a student too', () => {
    open();
    expect(screen.getAllByRole('menuitem').map(i => i.textContent.trim())).toEqual([
      'Profile', 'Notifications', 'Settings', 'Sign Out',
    ]);
  });

  /* "Notifications" opened notification SETTINGS here and the inbox from the
     phone's ⋯ sheet: one word, two destinations (A2). The inbox is what the
     owner's mobile layout names, and Settings is one item below. */
  it('opens the notifications inbox from Notifications', () => {
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Notifications' }));
    expect(screen.getByTestId('where').textContent).toBe('/notifications');
  });
});
