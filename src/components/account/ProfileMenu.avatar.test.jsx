import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProfileMenu from './ProfileMenu';

/**
 * The avatar in the bottom-left corner of the shell.
 *
 * ProfileMenu is the only component in the application that renders
 * `profile_picture_url` — every other avatar surface draws the emoji — so it is
 * the only place a broken picture is visible, and it was invisible in the worst
 * possible way.
 *
 * ── The incident ──
 *
 * The picture uploaded, re-encoded, wrote, stored its URL and reached session
 * state on the same frame, and the corner stayed empty. The file had been written
 * to a directory nothing served (see server/profilePicture.serving.test.js), so
 * the URL resolved to Vite's SPA fallback: 200, `content-type: text/html`. An
 * `<img>` handed HTML fires `error` and renders nothing at all — no emoji, no
 * broken-image glyph worth noticing, no console message anyone would connect to a
 * profile screen.
 *
 * The serving defect is fixed on the server. This file covers the half that has
 * to be true regardless: a picture that cannot be displayed, for ANY reason —
 * deleted behind the user's back, a cache purge, an offline moment, a deployment
 * that has not copied the uploads directory across — falls back to the emoji the
 * user picked, which is what that emoji is for. "Fallback" is literally the label
 * on the field in ProfileEditModal.
 */

const USER = (over = {}) => ({
  id: 'user-student-9',
  name: 'Alice Rivera',
  username: 'alice_rivera',
  role: 'student',
  verified: true,
  avatar: '🦊',
  profile_picture_url: null,
  ...over
});

const renderMenu = (over = {}) => render(
  <MemoryRouter>
    <ProfileMenu
      user={USER(over)}
      onEditProfile={vi.fn()}
      onSignOut={vi.fn()}
    />
  </MemoryRouter>
);

const chipImage = () => document.querySelector('.userchip img');

describe('the sidebar avatar', () => {
  it('shows the uploaded picture when there is one', () => {
    renderMenu({ profile_picture_url: '/uploads/avatars/user-student-9-1786201319245.webp' });

    const img = chipImage();
    expect(img).toBeTruthy();
    expect(img).toHaveAttribute('src', '/uploads/avatars/user-student-9-1786201319245.webp');
    // The emoji is not drawn underneath it.
    expect(screen.queryByText('🦊')).toBeNull();
  });

  it('shows the emoji when there is no picture', () => {
    renderMenu();

    expect(chipImage()).toBeNull();
    expect(screen.getByText('🦊')).toBeInTheDocument();
  });

  it('falls back to the emoji when the picture cannot be loaded', () => {
    renderMenu({ profile_picture_url: '/uploads/avatars/gone.webp' });

    const img = chipImage();
    expect(img).toBeTruthy();

    fireEvent.error(img);

    expect(chipImage()).toBeNull();
    expect(screen.getByText('🦊')).toBeInTheDocument();
  });

  /**
   * Both places the picture is drawn share one decision, so one failure must not
   * leave the open menu showing a blank circle while the chip has recovered.
   */
  it('falls back in the open menu as well as the chip', () => {
    renderMenu({ profile_picture_url: '/uploads/avatars/gone.webp' });

    fireEvent.click(screen.getByRole('button', { name: /alice rivera/i }));
    expect(document.querySelectorAll('img').length).toBe(2);

    fireEvent.error(document.querySelector('img'));

    expect(document.querySelectorAll('img').length).toBe(0);
    expect(screen.getAllByText('🦊').length).toBe(2);
  });

  /**
   * A NEW picture gets a new chance.
   *
   * The failure is remembered per URL rather than as a boolean, because a
   * re-upload mints a new filename: a boolean would latch the emoji on for the
   * life of the component and the user would replace a broken photograph with a
   * good one and see no change.
   */
  it('tries again when the picture is replaced', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ProfileMenu user={USER({ profile_picture_url: '/uploads/avatars/first.webp' })}
          onEditProfile={vi.fn()} onSignOut={vi.fn()} />
      </MemoryRouter>
    );

    fireEvent.error(chipImage());
    expect(chipImage()).toBeNull();

    rerender(
      <MemoryRouter>
        <ProfileMenu user={USER({ profile_picture_url: '/uploads/avatars/second.webp' })}
          onEditProfile={vi.fn()} onSignOut={vi.fn()} />
      </MemoryRouter>
    );

    expect(chipImage()).toHaveAttribute('src', '/uploads/avatars/second.webp');
  });
});

describe('what the avatar is called', () => {
  /**
   * `alt=""`, not `alt="Avatar"` and not the person's name.
   *
   * The image sits INSIDE the chip button, whose accessible name is already
   * assembled from the rendered name and role. `alt="Avatar"` made that name
   * "Avatar Alice Rivera Student" — a word that describes the widget rather than
   * the person, announced before every use of the only sign-out control on the
   * desktop shell. `alt="Alice Rivera"` would be worse: the name twice.
   *
   * The picture conveys nothing the button does not already say, which is the
   * definition of decorative, so it is marked decorative. The emoji span is
   * hidden for exactly the same reason — otherwise a screen reader reads "fox"
   * into the middle of the button's name.
   */
  it('adds nothing to the name of the button it sits in', () => {
    renderMenu({ profile_picture_url: '/uploads/avatars/a.webp' });

    expect(chipImage()).toHaveAttribute('alt', '');
    expect(screen.queryByAltText(/avatar/i)).toBeNull();
    // The name is exactly the two lines of text the chip renders, run together
    // because the DOM has no whitespace between the spans. What matters is what
    // is NOT in it: no "Avatar", and nothing about the image at all.
    expect(screen.getByRole('button', { name: 'Alice RiveraStudent' })).toBeInTheDocument();
  });

  it('does not read the emoji out as part of that name either', () => {
    renderMenu();

    expect(screen.getByText('🦊')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Alice RiveraStudent' })).toBeInTheDocument();
  });
});
