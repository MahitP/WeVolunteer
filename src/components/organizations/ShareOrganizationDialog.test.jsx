import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ShareOrganizationDialog from './ShareOrganizationDialog';
import { api } from '../../utils/api';

/**
 * Getting a club's invitation link out of the product.
 *
 * ── What this file is for ──
 *
 * Not the authorization: who may read the link is decided by `invite_policy` on
 * the server and proved in `server/routes.organizationShareLink.test.js`. This
 * covers the part no server test can — that the value actually reaches somebody,
 * on every browser, including the ones missing the APIs the nice path uses.
 *
 * `navigator.share` exists on phones and on almost no desktop.
 * `navigator.clipboard` is absent over plain HTTP and inside some embedded
 * webviews. A dialog whose only Copy control silently does nothing is worse than
 * one that shows the URL, because the reader cannot tell that it failed — so
 * both fallbacks are exercised rather than assumed.
 */

vi.mock('../../utils/api');

const TOKEN = 'a'.repeat(64);
const ORG = { name: 'Chess Club', slug: 'chess-club' };

const LINK = {
  exists: true,
  path: `/organizations/invite/${TOKEN}`,
  createdAt: '2026-09-01T09:00:00.000Z',
  rotations: 0,
  canCreate: true,
};

const show = async (link = LINK, props = {}) => {
  api.fetchOrganizationShareLink.mockResolvedValue(link);
  const utils = render(
    <ShareOrganizationDialog
      orgKey="chess-club"
      organization={ORG}
      policy="invite"
      onClose={vi.fn()}
      addToast={props.addToast ?? vi.fn()}
      onChanged={vi.fn()}
      {...props}
    />,
  );
  await waitFor(() => expect(api.fetchOrganizationShareLink).toHaveBeenCalledWith('chess-club'));
  return utils;
};

let clipboard;
let share;

beforeEach(() => {
  vi.clearAllMocks();
  clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  share = undefined;
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  api.createOrganizationShareLink.mockResolvedValue({ exists: true, path: LINK.path, rotated: true });
  api.revokeOrganizationShareLink.mockResolvedValue({ exists: false, revoked: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
});

describe('the link itself', () => {
  it('is shown as an absolute URL in a field somebody can select', async () => {
    await show();
    const field = await screen.findByLabelText('Invitation link');
    expect(field).toHaveAttribute('readonly');
    expect(field.value).toMatch(new RegExp(`^https?://[^/]+/organizations/invite/${TOKEN}$`));
  });

  it('says when it was made, and how often it has been replaced', async () => {
    await show({ ...LINK, rotations: 3 });
    expect(await screen.findByText(/regenerated 3 times/)).toBeInTheDocument();
  });

  it('says "1 time" in the singular', async () => {
    await show({ ...LINK, rotations: 1 });
    expect(await screen.findByText(/regenerated 1 time$/)).toBeInTheDocument();
  });
});

describe('copying', () => {
  it('puts the URL on the clipboard and says so', async () => {
    const addToast = vi.fn();
    await show(LINK, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Copy link/ }));

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(`/organizations/invite/${TOKEN}`),
    ));
    expect(addToast).toHaveBeenCalledWith('Invitation link copied.', 'success');
  });

  /**
   * No clipboard API at all — plain HTTP, or an embedded webview.
   *
   * The reader gets the URL in a toast, and the field is still there to select
   * by hand. Deliberately `info` and not `error`: nothing has gone wrong for
   * them, and the value they wanted is on screen.
   */
  it('shows the URL instead when there is no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const addToast = vi.fn();
    await show(LINK, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Copy link/ }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining(`/organizations/invite/${TOKEN}`), 'info',
    ));
  });

  it('shows the URL instead when the clipboard write is refused', async () => {
    clipboard.writeText.mockRejectedValue(new Error('permission denied'));
    const addToast = vi.fn();
    await show(LINK, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Copy link/ }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining(`/organizations/invite/${TOKEN}`), 'info',
    ));
  });
});

describe('the share sheet', () => {
  /* Not drawn where it cannot work. A control that silently does nothing costs
     more trust than an absent one. */
  it('is absent where the browser has no share sheet', async () => {
    await show();
    await screen.findByRole('button', { name: /Copy link/ });
    expect(screen.queryByRole('button', { name: /Share…/ })).not.toBeInTheDocument();
  });

  it('is offered where it exists, and hands over the URL', async () => {
    share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });

    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Share…/ }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Chess Club',
      url: expect.stringContaining(`/organizations/invite/${TOKEN}`),
    })));
  });

  it('says nothing when somebody cancels the share sheet', async () => {
    share = vi.fn().mockRejectedValue(new Error('AbortError'));
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const addToast = vi.fn();

    await show(LINK, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Share…/ }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    /* A cancelled share is not a failure. */
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe('a club with no link yet', () => {
  it('offers a manager the way to make one', async () => {
    await show({ exists: false, canCreate: true });
    expect(await screen.findByText('No invitation link yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Create invitation link/ }));
    await waitFor(() => expect(api.createOrganizationShareLink).toHaveBeenCalledWith('chess-club'));
  });

  it('tells a member who may share but not create whose job it is', async () => {
    await show({ exists: false, canCreate: false });
    expect(await screen.findByText(/Ask a manager of this organization to create one/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create invitation link/ })).not.toBeInTheDocument();
  });
});

describe('replacing and switching off', () => {
  /**
   * Both behind a confirmation, and both saying the one thing a manager is
   * afraid of.
   *
   * The realistic fear on pressing Regenerate is that it empties the club. It
   * does not — `organization_members` is untouched — and saying so is the whole
   * reason these dialogs have prose rather than a verb.
   */
  it('confirms a regeneration, and promises membership is untouched', async () => {
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /^Regenerate$/ }));

    expect(await screen.findByText(/Every copy of the current link stops working/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody loses their membership/)).toBeInTheDocument();
    expect(api.createOrganizationShareLink).not.toHaveBeenCalled();

    /* The confirmation's own verb, which is deliberately not the same word as
       the control that opened it. */
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate link$/ }));
    await waitFor(() => expect(api.createOrganizationShareLink).toHaveBeenCalledWith('chess-club'));
  });

  it('confirms switching off, and names the consequence for an invite-only club', async () => {
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Turn off link/ }));

    expect(await screen.findByText(/no invitation link until a manager/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody loses their membership/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Turn it off$/ }));
    await waitFor(() => expect(api.revokeOrganizationShareLink).toHaveBeenCalledWith('chess-club'));
  });

  it('does not offer either to somebody who may only share', async () => {
    await show({ ...LINK, canCreate: false });
    await screen.findByRole('button', { name: /Copy link/ });
    expect(screen.queryByRole('button', { name: /^Regenerate$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn off link/ })).not.toBeInTheDocument();
  });

  it('surfaces a refusal rather than pretending it worked', async () => {
    api.createOrganizationShareLink.mockRejectedValue(new Error('You do not manage this organization.'));
    const addToast = vi.fn();
    await show(LINK, { addToast });

    fireEvent.click(await screen.findByRole('button', { name: /^Regenerate$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate link$/ }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('You do not manage this organization.', 'error'));
  });
});

/**
 * What the dialog says the link does, per policy.
 *
 * There is no wording that is honest about all three: "only people you send it
 * to can join" is true of an invitation-only club and false of the other two,
 * and telling a manager of a request-to-join club that the link controls
 * admission is exactly the misunderstanding this dialog exists to prevent.
 */
describe('what the dialog says the link does', () => {
  it('tells an invitation-only club that the link is what admits people', async () => {
    await show(LINK, { policy: 'invite' });
    expect(await screen.findByText(/only people who have it can join/)).toBeInTheDocument();
  });

  it('tells an open club that the link is an address and not a password', async () => {
    await show(LINK, { policy: 'open' });
    expect(await screen.findByText(/not a password/)).toBeInTheDocument();
  });

  it('tells a request-to-join club that a manager still decides', async () => {
    await show(LINK, { policy: 'request' });
    expect(await screen.findByText(/still accepts or declines every one/)).toBeInTheDocument();
  });
});

describe('dialog behaviour', () => {
  it('is a real dialog, so Escape and focus containment come for free', async () => {
    await show();
    const dialog = await screen.findByRole('dialog', { name: /Share Chess Club/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('reports a failed load rather than an empty dialog', async () => {
    api.fetchOrganizationShareLink.mockRejectedValue(new Error('the server is down'));
    render(
      <ShareOrganizationDialog
        orgKey="chess-club" organization={ORG} policy="invite"
        onClose={vi.fn()} addToast={vi.fn()} onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('the server is down');
  });
});
