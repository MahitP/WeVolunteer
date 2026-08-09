import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProfileEditModal from './ProfileEditModal';
import ProfileMenu from './account/ProfileMenu';
import { api } from '../utils/api';

vi.mock('../utils/api');

/**
 * Saving a profile picture, and the two things that have to be true afterwards.
 *
 * ── 1. The new picture is on screen without a reload ──
 *
 * There is no store and no cache to invalidate: `SessionProvider` holds
 * `currentUser`, App.jsx hands this modal an `onSave` that calls
 * `setCurrentUser`, and every avatar surface reads from that one value. So the
 * whole requirement reduces to "hand `onSave` the user object the server just
 * returned" — which both picture endpoints return, formatted by
 * `formatUserResponse`, with `profile_picture_url` on it. No `/api/auth/me`
 * round trip, no reload. The harness at the bottom of this file renders the real
 * ProfileMenu against real state and proves the corner updates in place, because
 * "it re-renders" is the claim and a mock of `onSave` cannot make it.
 *
 * ── 2. A refused picture does not leave half the form saved ──
 *
 * The order used to be: save the text fields, THEN upload the picture. The
 * picture is the only part of this form the server can refuse — over 5 MB, not an
 * image, bytes that will not decode — so the ordinary failure was the one that
 * had already written the name, school, bio and skills before it happened. The
 * user was shown "Could not save", the modal stayed open, `onSave` was never
 * called, and the fields on screen no longer matched either the database (which
 * had the new text) or the session (which had the old). Reloading "undid" an edit
 * that had in fact been saved.
 *
 * The image goes first now. A rejected photograph costs nothing, and anything
 * that DID land is still pushed into session state on the way out of the failure.
 */

const USER = {
  id: 'user-student-9',
  name: 'Alice Rivera',
  username: 'alice_rivera',
  role: 'student',
  verified: true,
  avatar: '🦊',
  bio: 'Likes clearing trails',
  school: 'South Brunswick High',
  grade: '11',
  skills: ['Tutoring'],
  leaderboardOptIn: false,
  profile_picture_url: null
};

const UPLOADED = '/uploads/avatars/user-student-9-1786201319245.webp';

/** The user as the server returns it once the picture is stored. */
const withPicture = (over = {}) => ({ ...USER, profile_picture_url: UPLOADED, ...over });

const pickFile = () => {
  const input = document.querySelector('input[type="file"]');
  const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
};

const save = () => fireEvent.submit(document.getElementById('profile-form'));

let objectUrls;

/**
 * The three endpoints, backed by one row.
 *
 * Deliberately stateful rather than three fixed resolutions: all three return the
 * user as `formatUserResponse` renders the row AFTER their write, so
 * `updateProfile` answering with `profile_picture_url: null` a moment after an
 * upload set it is not a thing the server can do — and a test built on that
 * fiction would pass while the last write silently reverted the avatar.
 */
let serverUser;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom implements neither, and the modal draws a local preview from them.
  objectUrls = [];
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:preview-${objectUrls.length}`;
    objectUrls.push(u);
    return u;
  });
  URL.revokeObjectURL = vi.fn();

  serverUser = { ...USER };
  api.updateProfile.mockImplementation(async (patch) => {
    serverUser = { ...serverUser, ...patch };
    return { user: serverUser };
  });
  api.uploadProfilePicture.mockImplementation(async () => {
    serverUser = { ...serverUser, profile_picture_url: UPLOADED };
    return { success: true, user: serverUser };
  });
  api.deleteProfilePicture.mockImplementation(async () => {
    serverUser = { ...serverUser, profile_picture_url: null };
    return { success: true, user: serverUser };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const renderModal = (props = {}) => {
  const onSave = props.onSave ?? vi.fn();
  const addToast = props.addToast ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <ProfileEditModal
      user={props.user ?? USER}
      onClose={onClose}
      onSave={onSave}
      addToast={addToast}
    />
  );
  return { onSave, addToast, onClose };
};

describe('saving a picture', () => {
  it('hands the caller the user the server returned, with the URL on it', async () => {
    const { onSave, onClose } = renderModal();
    pickFile();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].profile_picture_url).toBe(UPLOADED);
    expect(onClose).toHaveBeenCalled();
  });

  it('never hands the caller a missing user', async () => {
    // `onSave` is `setCurrentUser`. Anything falsy here blanks the session and
    // takes the whole shell down with it on the next render.
    const { onSave } = renderModal();
    pickFile();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    for (const [arg] of onSave.mock.calls) expect(arg).toBeTruthy();
  });

  it('does not re-read the session to find out what it just wrote', async () => {
    const { onSave } = renderModal();
    pickFile();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(api.getMe).not.toHaveBeenCalled();
  });

  it('sends the picture before it writes the text fields', async () => {
    const order = [];
    const upload = api.uploadProfilePicture.getMockImplementation();
    const patch = api.updateProfile.getMockImplementation();
    api.uploadProfilePicture.mockImplementation(async (...a) => { order.push('picture'); return upload(...a); });
    api.updateProfile.mockImplementation(async (...a) => { order.push('text'); return patch(...a); });

    const { onSave } = renderModal();
    pickFile();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(order).toEqual(['picture', 'text']);
  });

  it('leaves the text fields untouched when the picture is refused', async () => {
    api.uploadProfilePicture.mockRejectedValue(
      Object.assign(new Error('That image is too large. The limit is 5MB.'), { status: 413 })
    );

    const { onSave, addToast, onClose } = renderModal();
    pickFile();
    save();

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/could not save/i), 'error'
    ));

    // The point of the whole ordering change.
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // Still open, still holding what the user typed, so they can retry or drop
    // the photograph.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still reports the picture when the text write fails after it', async () => {
    api.updateProfile.mockRejectedValue(new Error('boom'));

    const { onSave, addToast } = renderModal();
    pickFile();
    save();

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/could not save/i), 'error'
    ));

    // The picture IS stored. Not telling the session about it leaves the sidebar
    // showing an emoji for a photograph the server is already serving, until the
    // next reload.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].profile_picture_url).toBe(UPLOADED);
  });

  it('does not send a picture request when no file was chosen', async () => {
    const { onSave } = renderModal();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(api.uploadProfilePicture).not.toHaveBeenCalled();
    expect(api.deleteProfilePicture).not.toHaveBeenCalled();
  });
});

describe('removing a picture', () => {
  it('asks the server to delete it and reports the cleared user', async () => {
    const { onSave } = renderModal({ user: withPicture() });

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(api.deleteProfilePicture).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].profile_picture_url).toBeNull();
  });

  it('does not call the delete endpoint for someone who has no picture', async () => {
    const { onSave } = renderModal();
    save();

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(api.deleteProfilePicture).not.toHaveBeenCalled();
  });
});

/**
 * The bit the bug report was actually about.
 *
 * `Shell` is the composition App.jsx performs — one piece of state, the modal
 * writing to it through `onSave`, ProfileMenu reading from it — with nothing
 * mocked between them. Nothing here remounts and nothing re-fetches, so if the
 * corner shows the photograph at the end of this test it did so from a state
 * update alone.
 */
function Shell() {
  const [currentUser, setCurrentUser] = useState(USER);
  const [editing, setEditing] = useState(true);
  return (
    <MemoryRouter>
      <div className="sidebar-foot">
        <ProfileMenu user={currentUser} onEditProfile={() => setEditing(true)} onSignOut={vi.fn()} />
      </div>
      {editing && (
        <ProfileEditModal
          user={currentUser}
          onClose={() => setEditing(false)}
          onSave={setCurrentUser}
          addToast={vi.fn()}
        />
      )}
    </MemoryRouter>
  );
}

describe('the bottom-left corner of the shell', () => {
  it('shows the new picture as soon as it is saved, with no reload', async () => {
    render(<Shell />);

    // Before: the emoji, because there is no picture yet.
    expect(document.querySelector('.userchip img')).toBeNull();

    pickFile();
    save();

    await waitFor(() => {
      expect(document.querySelector('.userchip img')).toHaveAttribute('src', UPLOADED);
    });
    expect(api.getMe).not.toHaveBeenCalled();
  });

  it('goes back to the emoji as soon as the picture is removed', async () => {
    render(<Shell />);
    pickFile();
    save();
    await waitFor(() => expect(document.querySelector('.userchip img')).not.toBeNull());

    // Through the menu, the way the user reaches it: open the chip, then Edit.
    fireEvent.click(document.querySelector('.userchip'));
    fireEvent.click(screen.getByRole('menuitem', { name: /edit profile/i }));
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    save();

    await waitFor(() => expect(document.querySelector('.userchip img')).toBeNull());
    expect(document.querySelector('.userchip span[aria-hidden="true"]')).toHaveTextContent('🦊');
  });
});
