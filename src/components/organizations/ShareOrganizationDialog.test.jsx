import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
 *
 * ── And the one thing this dialog now has to get right ──
 *
 * It presents two kinds of value that look identical and are not: a PUBLIC
 * ADDRESS, which is readable, permanent and grants nothing, and INVITATION
 * LINKS, which are credentials that can be revoked and that make a Join press
 * succeed. Every assertion about the address section is really an assertion that
 * the difference is on screen — because the difference is the security model.
 */

vi.mock('../../utils/api');

const TOKEN = 'a'.repeat(64);
const ORG = { name: 'Chess Club', slug: 'chess-club', visibility: 'unlisted' };

const LINK = {
  id: 'oshl-1',
  path: `/organizations/invite/${TOKEN}`,
  label: 'General',
  state: 'live',
  createdAt: '2026-09-01T09:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  uses: 0,
  lastUsedAt: null,
};

/**
 * `payload` is the whole endpoint answer, because who sees what is decided
 * there: a manager gets every link with its stats, and a member who may only
 * share gets one link with none. Passing the shape rather than a link is what
 * lets one helper drive both readers.
 */
const show = async (payload = { links: [LINK], canManage: true, canCreate: true }, props = {}) => {
  api.fetchOrganizationShareLinks.mockResolvedValue({ maxLinks: 10, ...payload });
  const utils = render(
    <ShareOrganizationDialog
      orgKey="chess-club"
      organization={props.organization ?? ORG}
      policy="invite"
      onClose={vi.fn()}
      addToast={props.addToast ?? vi.fn()}
      onChanged={vi.fn()}
      {...props}
    />,
  );
  await waitFor(() => expect(api.fetchOrganizationShareLinks).toHaveBeenCalledWith('chess-club'));
  return utils;
};

/** A manager's view of one live link. */
const MANAGED = { links: [LINK], canManage: true, canCreate: true };
/** Somebody who may pass the link on and not decide what it is. */
const SHARER = { links: [LINK], canManage: false, canCreate: false };

let clipboard;
let share;

beforeEach(() => {
  vi.clearAllMocks();
  clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  share = undefined;
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  api.createOrganizationShareLink.mockResolvedValue({ link: LINK });
  api.rotateOrganizationShareLink.mockResolvedValue({ link: LINK, rotated: true });
  api.revokeOrganizationShareLink.mockResolvedValue({ link: { ...LINK, state: 'revoked' }, revoked: true });
  api.updateOrganizationShareLink.mockResolvedValue({ link: LINK });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
});

describe('the link itself', () => {
  it('is shown as an absolute URL in a field somebody can select', async () => {
    await show();
    /* Labelled by its own name, which is how a manager tells four links apart. */
    const field = await screen.findByLabelText('General');
    expect(field).toHaveAttribute('readonly');
    expect(field.value).toMatch(new RegExp(`^https?://[^/]+/organizations/invite/${TOKEN}$`));
  });

  it('says when it was made and how many people joined through it', async () => {
    await show({ ...MANAGED, links: [{ ...LINK, uses: 12 }] });
    expect(await screen.findByText(/12 people joined/)).toBeInTheDocument();
  });

  it('counts one person in the singular', async () => {
    await show({ ...MANAGED, links: [{ ...LINK, uses: 1 }] });
    expect(await screen.findByText(/1 person joined/)).toBeInTheDocument();
  });

  /**
   * The join count is a manager's number, not a sharer's.
   *
   * It is aggregate and not sensitive in itself — no visitor, no address, no
   * referrer is stored anywhere — but it is the club's operational record, and
   * somebody who may hand an address out has not been given a reason to read
   * it.
   */
  it('keeps the join count from somebody who may only share', async () => {
    await show(SHARER);
    await screen.findByLabelText('General');
    expect(screen.queryByText(/joined/)).not.toBeInTheDocument();
  });

  it('says when a link will stop working, where one will', async () => {
    await show({ ...MANAGED, links: [{ ...LINK, expiresAt: '2026-12-01T23:59:59.000Z' }] });
    expect(await screen.findByText(/stops working/)).toBeInTheDocument();
  });

  /**
   * Several links, each its own plate.
   *
   * The reason this feature exists: retiring the flyer that has been on the
   * corridor wall since September must not break the Instagram bio.
   */
  it('shows every working link with its own name and URL', async () => {
    const flyer = { ...LINK, id: 'oshl-2', label: 'Autumn flyer', path: `/organizations/invite/${'b'.repeat(64)}` };
    await show({ ...MANAGED, links: [LINK, flyer] });

    expect(await screen.findByLabelText('General')).toBeInTheDocument();
    const second = screen.getByLabelText('Autumn flyer');
    expect(second.value).toContain('b'.repeat(64));
    expect(second.value).not.toContain(TOKEN);
  });
});

/**
 * The public address, and why it is a separate thing on screen.
 *
 * A handle is an ADDRESS: readable, printable, permanent, and it grants nothing.
 * An invitation link is a CREDENTIAL. Presenting them together and labelled is
 * the only way a manager can be expected to tell them apart, and telling them
 * apart is the whole security model.
 */
const PUBLIC_ORG = { ...ORG, visibility: 'public' };

describe('the public address', () => {

  it('is offered for a club that has a public page', async () => {
    await show(MANAGED, { organization: PUBLIC_ORG });
    const field = await screen.findByLabelText('Public address');
    expect(field.value).toMatch(/\/organizations\/@chess-club$/);
  });

  it('says plainly that it does not let anybody join', async () => {
    await show(MANAGED, { organization: PUBLIC_ORG });
    expect(await screen.findByText(/does not let anybody join/)).toBeInTheDocument();
  });

  /**
   * Absent, not shown with a warning.
   *
   * An address that answers "not found" to everybody outside the club is not an
   * address, and offering one would have managers printing a URL that does not
   * work.
   */
  it('is absent for an unlisted club', async () => {
    await show(MANAGED);
    await screen.findByLabelText('General');
    expect(screen.queryByLabelText('Public address')).not.toBeInTheDocument();
  });

  /**
   * But a manager is told the option exists.
   *
   * Migration 063 backfills every club that predates the setting to
   * `unlisted`, so on the day this shipped every existing manager opened Share,
   * saw only invitation links, and had no signal that a public page was a thing
   * they could have.
   */
  it('tells an unlisted club’s manager where to turn one on', async () => {
    await show(MANAGED);
    expect(await screen.findByText(/no public address/)).toBeInTheDocument();
    expect(screen.getByText(/Who can see this organization’s page/)).toBeInTheDocument();
  });

  /* Not to a member who may share, because they cannot change the setting and
     the sentence would be an instruction they cannot follow. */
  it('does not say it to somebody who cannot change it', async () => {
    await show(SHARER);
    await screen.findByLabelText('General');
    expect(screen.queryByText(/no public address/)).not.toBeInTheDocument();
  });

  it('says nothing about it once the club is public', async () => {
    await show(MANAGED, { organization: PUBLIC_ORG });
    await screen.findByLabelText('Public address');
    expect(screen.queryByText(/no public address/)).not.toBeInTheDocument();
  });

  it('is not the invitation link', async () => {
    await show(MANAGED, { organization: PUBLIC_ORG });
    const address = await screen.findByLabelText('Public address');
    expect(address.value).not.toContain(TOKEN);
  });
});

describe('copying', () => {
  it('puts the URL on the clipboard and says so', async () => {
    const addToast = vi.fn();
    await show(MANAGED, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Copy link/ }));

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(`/organizations/invite/${TOKEN}`),
    ));
    expect(addToast).toHaveBeenCalledWith('Invitation link copied.', 'success');
  });

  /**
   * No clipboard API at all — plain HTTP, or an embedded webview.
   *
   * The reader is pointed at the field, which is still there and still selects
   * its whole value on focus. Deliberately `info` and not `error`: nothing has
   * gone wrong for them, and the value they wanted is on screen.
   *
   * It used to pass the URL itself, on the reasoning that `info` shows it long
   * enough to select. It does not — `addToast` dismisses after five seconds,
   * and the 64-character token has no break opportunity, so the toast also
   * rendered wider than a phone viewport allows.
   */
  it('points at the field when there is no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const addToast = vi.fn();
    await show(MANAGED, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Copy link/ }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('Select the link in the box'), 'info',
    ));
    /* And never the URL itself, which is what made the toast unusable. */
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining(TOKEN), expect.anything());
    /* The field is the fallback, so it has to still be there, still hold the
       URL, and still be selectable. */
    const field = screen.getByLabelText('Invitation link: General');
    expect(field.value).toContain(`/organizations/invite/${TOKEN}`);
    expect(field).toHaveAttribute('readonly');
  });

  it('points at the field when the clipboard write is refused', async () => {
    clipboard.writeText.mockRejectedValue(new Error('permission denied'));
    const addToast = vi.fn();
    await show(MANAGED, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Copy link/ }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('Select the link in the box'), 'info',
    ));
  });

  /**
   * The field says what kind of value it holds.
   *
   * With the visible label alone, a screen-reader user heard "Public address,
   * edit text" and then "Autumn flyer, edit text" — and the distinction this
   * dialog exists to draw was carried entirely by a dashed border.
   */
  it('names the invitation field as an invitation link', async () => {
    await show(MANAGED);
    const field = await screen.findByLabelText('Invitation link: General');
    expect(field.value).toContain(`/organizations/invite/${TOKEN}`);
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

    await show(MANAGED, { addToast });
    fireEvent.click(await screen.findByRole('button', { name: /Share…/ }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    /* A cancelled share is not a failure. */
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe('a club with no link yet', () => {
  it('offers a manager the way to make one', async () => {
    await show({ links: [], canManage: true, canCreate: true });
    expect(await screen.findByText('No invitation link yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New link/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Create link/ }));

    /* An unnamed link gets the server's default label, so `label` is
       `undefined` rather than an empty string — and no expiry, because a link
       that lapses must be something somebody chose. */
    await waitFor(() => expect(api.createOrganizationShareLink).toHaveBeenCalledWith(
      'chess-club', { label: undefined, expiresAt: null },
    ));
  });

  it('sends the name a manager typed', async () => {
    await show({ links: [], canManage: true, canCreate: true });
    fireEvent.click(await screen.findByRole('button', { name: /New link/ }));
    fireEvent.change(screen.getByLabelText(/What is this link for/), {
      target: { value: 'Autumn flyer' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create link/ }));

    await waitFor(() => expect(api.createOrganizationShareLink).toHaveBeenCalledWith(
      'chess-club', { label: 'Autumn flyer', expiresAt: null },
    ));
  });

  /**
   * The warning before a link that lapses.
   *
   * An expiry is the one thing in this dialog that breaks LATER, when nobody is
   * looking at it: the flyer works in September and quietly stops in October.
   * The default is no expiry, and choosing one says what it costs.
   */
  it('warns before making a link that expires, and defaults to one that does not', async () => {
    await show({ links: [], canManage: true, canCreate: true });
    fireEvent.click(await screen.findByRole('button', { name: /New link/ }));

    expect(screen.getByText(/keeps working until you switch it off/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Stop working after/), { target: { value: '2026-12-01' } });
    expect(screen.getByText(/stop letting anybody in after that date/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create link/ }));
    await waitFor(() => expect(api.createOrganizationShareLink).toHaveBeenCalledWith(
      'chess-club',
      { label: undefined, expiresAt: expect.stringContaining('2026-12-01') },
    ));
  });

  it('tells a member who may share but not create whose job it is', async () => {
    await show({ links: [], canManage: false, canCreate: false });
    expect(await screen.findByText(/Ask a manager of this organization to create one/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New link/ })).not.toBeInTheDocument();
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

    expect(await screen.findByText(/Every copy of this link stops working/)).toBeInTheDocument();
    /* And that the club's OTHER links carry on — the reason a club has several. */
    expect(screen.getByText(/Your other links are not affected/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody loses their membership/)).toBeInTheDocument();
    expect(api.rotateOrganizationShareLink).not.toHaveBeenCalled();

    /* The confirmation's own verb, which is deliberately not the same word as
       the control that opened it. */
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate link$/ }));
    await waitFor(() => expect(api.rotateOrganizationShareLink)
      .toHaveBeenCalledWith('chess-club', 'oshl-1'));
  });

  it('names the link in the confirmation, so a manager sees which one', async () => {
    const flyer = { ...LINK, id: 'oshl-2', label: 'Autumn flyer' };
    await show({ ...MANAGED, links: [LINK, flyer] });

    const plate = (await screen.findByLabelText('Autumn flyer')).closest('.org-share-plate');
    fireEvent.click(within(plate).getByRole('button', { name: /^Regenerate$/ }));

    expect(await screen.findByText(/Regenerate “Autumn flyer”\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Regenerate link$/ }));
    await waitFor(() => expect(api.rotateOrganizationShareLink)
      .toHaveBeenCalledWith('chess-club', 'oshl-2'));
  });

  it('confirms switching off, and names the consequence for a club with one link', async () => {
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Switch off/ }));

    expect(await screen.findByText(/This is the only one that works/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody loses their membership/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Switch it off$/ }));
    await waitFor(() => expect(api.revokeOrganizationShareLink)
      .toHaveBeenCalledWith('chess-club', 'oshl-1'));
  });

  /**
   * With more than one link the "nobody can join" warning is not true, and
   * must not be said.
   */
  it('does not warn about locking the club out when other links work', async () => {
    const flyer = { ...LINK, id: 'oshl-2', label: 'Autumn flyer' };
    await show({ ...MANAGED, links: [LINK, flyer] });

    const plate = (await screen.findByLabelText('General')).closest('.org-share-plate');
    fireEvent.click(within(plate).getByRole('button', { name: /Switch off/ }));

    expect(await screen.findByText(/Your other links carry on/)).toBeInTheDocument();
    expect(screen.queryByText(/This is the only one that works/)).not.toBeInTheDocument();
  });

  it('renames a link without touching the link itself', async () => {
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Rename “General”/ }));
    fireEvent.change(screen.getByLabelText('Rename this link'), { target: { value: 'Instagram' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(api.updateOrganizationShareLink)
      .toHaveBeenCalledWith('chess-club', 'oshl-1', { label: 'Instagram' }));
    /* A rename is not a rotation. The URL people already have keeps working. */
    expect(api.rotateOrganizationShareLink).not.toHaveBeenCalled();
  });

  it('clears an expiry, so a temporary link can become permanent', async () => {
    await show({ ...MANAGED, links: [{ ...LINK, expiresAt: '2026-12-01T23:59:59.000Z' }] });
    fireEvent.click(await screen.findByRole('button', { name: /Change expiry/ }));
    fireEvent.change(screen.getByLabelText('Stop working after'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(api.updateOrganizationShareLink)
      .toHaveBeenCalledWith('chess-club', 'oshl-1', { expiresAt: null }));
  });

  /**
   * The links that stopped working stay visible.
   *
   * A manager needs to see that the autumn flyer is the one that lapsed — and
   * the join count beside it is the only record that the flyer worked at all.
   */
  it('keeps revoked and expired links visible to a manager, with their counts', async () => {
    await show({
      ...MANAGED,
      links: [
        LINK,
        { ...LINK, id: 'oshl-2', label: 'Autumn flyer', state: 'expired', uses: 9 },
        { ...LINK, id: 'oshl-3', label: 'Old QR code', state: 'revoked', uses: 4 },
      ],
    });

    fireEvent.click(await screen.findByText(/2 links no longer working/));
    expect(screen.getByText('Autumn flyer')).toBeInTheDocument();
    expect(screen.getByText(/Expired · 9 people joined/)).toBeInTheDocument();
    expect(screen.getByText(/Switched off · 4 people joined/)).toBeInTheDocument();
  });

  it('does not offer the URL of a dead link for copying', async () => {
    await show({
      ...MANAGED,
      links: [{ ...LINK, state: 'revoked' }],
    });
    await screen.findByText(/1 link no longer working/);
    expect(screen.queryByLabelText('General')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy link/ })).not.toBeInTheDocument();
  });

  /**
   * At the ceiling the control is reachable and refuses, rather than being
   * removed from the tab order with its reason attached to nothing.
   */
  it('refuses to offer another link once the club is at its ceiling', async () => {
    await show({ ...MANAGED, canCreate: false });
    const button = await screen.findByRole('button', { name: /New link/ });

    expect(button).toHaveAttribute('aria-disabled', 'true');
    /* Reachable: `disabled` would have taken it out of the tab order and left
       the explanation associated with nothing. */
    expect(button).not.toBeDisabled();
    const reason = screen.getByText(/Switch one off to make another/);
    expect(button).toHaveAttribute('aria-describedby', reason.id);

    /* And pressing it does nothing, so the state is still enforced. */
    fireEvent.click(button);
    expect(screen.queryByLabelText(/What is this link for/)).not.toBeInTheDocument();
  });

  it('does not offer either to somebody who may only share', async () => {
    await show(SHARER);
    await screen.findByRole('button', { name: /Copy link/ });
    expect(screen.queryByRole('button', { name: /^Regenerate$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch off/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expiry/ })).not.toBeInTheDocument();
  });

  it('surfaces a refusal rather than pretending it worked', async () => {
    api.rotateOrganizationShareLink.mockRejectedValue(new Error('You do not manage this organization.'));
    const addToast = vi.fn();
    await show(MANAGED, { addToast });

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
    await show(MANAGED, { policy: 'invite' });
    expect(await screen.findByText(/only people who have one can join/)).toBeInTheDocument();
  });

  /**
   * And it says the thing that is true of all three, which is the one that
   * used to be missing.
   *
   * The `open` sentence read "They are addresses to hand out — not passwords."
   * Nothing rotates a link when `join_policy` tightens — deliberately, because
   * a link on a printed flyer has to keep working — so a manager who followed
   * that advice, posted the link publicly, and later switched to Invitation
   * only had a live credential on a public feed and had never been told.
   */
  it.each(['open', 'invite', 'request'])(
    'tells a %s club to treat the links as private, whatever the policy',
    async (policy) => {
      await show(MANAGED, { policy });
      expect(await screen.findByText(/treat them as private/)).toBeInTheDocument();
    },
  );

  /**
   * And says it in the singular to somebody who can only see one link.
   *
   * A member with share rights is given the club's primary link and nothing
   * else, so a sentence about "these links" described a list they cannot see.
   */
  it.each(['open', 'invite', 'request'])(
    'says it in the singular to a sharer on a %s club',
    async (policy) => {
      await show(SHARER, { policy });
      expect(await screen.findByText(/treat it as private/)).toBeInTheDocument();
      expect(screen.queryByText(/treat them as private/)).not.toBeInTheDocument();
    },
  );

  it('points an open club at the public address for anything public', async () => {
    await show(MANAGED, { policy: 'open' });
    expect(await screen.findByText(/for a poster, use the public address/)).toBeInTheDocument();
  });

  it('warns that the links survive a change of policy', async () => {
    await show(MANAGED, { policy: 'open' });
    expect(await screen.findByText(/keep working if you change who can join/)).toBeInTheDocument();
  });

  it('tells a request-to-join club that a manager still decides', async () => {
    await show(MANAGED, { policy: 'request' });
    expect(await screen.findByText(/still accepts or declines every one/)).toBeInTheDocument();
  });
});

describe('dialog behaviour', () => {
  it('is a real dialog, so Escape and focus containment come for free', async () => {
    await show();
    const dialog = await screen.findByRole('dialog', { name: /Share Chess Club/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  /**
   * The security sentence is in the dialog's accessible DESCRIPTION.
   *
   * `WHAT_THE_LINK_DOES` is the sentence that tells a manager whether these
   * links are credentials. It used to be a bare paragraph a screen-reader user
   * had to arrow to: the dialog announced "Share Chess Club, dialog" and the
   * one distinction it exists to draw was not in the announcement.
   */
  it('announces what the links are, not just the club name', async () => {
    await show(MANAGED, { policy: 'invite' });
    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy);
    expect(description).toBeTruthy();
    expect(description.textContent).toMatch(/only people who have one can join/);
  });

  it('reports a failed load rather than an empty dialog', async () => {
    api.fetchOrganizationShareLinks.mockRejectedValue(new Error('the server is down'));
    render(
      <ShareOrganizationDialog
        orgKey="chess-club" organization={ORG} policy="invite"
        onClose={vi.fn()} addToast={vi.fn()} onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('the server is down');
  });
});
