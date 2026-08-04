/**
 * What each theme says, for each failure it is allowed to explain.
 *
 * ── Why copy lives with the theme, not with the kind ──
 *
 * The themes are not skins. Each is a different way of explaining the same
 * event, so the words and the picture have to be written together: "the sign-up
 * sheet wandered off" only means anything beside a corkboard, and "there's a
 * steward on this corridor" only means anything beside a map. Copy split from
 * illustration is exactly how a rotation starts feeling like one design with
 * six wallpapers.
 *
 * ── The tone ladder ──
 *
 * `404`, `403`, `chunk` and `maintenance` carry personality: a dead link, a
 * locked door, a stale tab and planned downtime are all mildly annoying and
 * warmth is welcome.
 *
 * `500`, `crash`, `offline` and `expired` are written FLAT, in every theme.
 * Somebody meeting one of those may have just lost work, and a joke told at
 * that moment reads as not understanding what happened to them — it spends
 * precisely the trust an error screen exists to keep. Each serious kind says
 * what happened, that their data is safe, and what to do, in its own
 * vocabulary, at its quietest.
 *
 * This is enforced, not encouraged: `errorCopy.test.js` fails the build if a
 * serious kind omits the reassurance or reaches for an exclamation mark.
 *
 * ── The reassurance is the first question, not a formality ──
 *
 * "Did I just lose my hours?" is what a volunteer actually wants to know when a
 * page dies mid-signup. Answering it outranks explaining what broke, so it
 * comes before the retry advice in every serious body.
 */

export const COPY = Object.freeze({
  /* ── The Bulletin Board ── physical, hallway-level, sheets and pins. */
  board: Object.freeze({
    404: {
      eyebrow: 'Nothing pinned here',
      title: 'The sign-up sheet wandered off',
      body: 'This link points at a spot on the board that isn’t there any more — the shift may have filled, or the page may have moved. Nothing is wrong with your account.',
    },
    403: {
      eyebrow: 'Wrong pin',
      title: 'That sheet is pinned up for someone else',
      body: 'This part of the board is limited to certain accounts. If you should be on it, your school administrator can add you.',
    },
    500: {
      eyebrow: 'Our side',
      title: 'We’re re-pinning the board',
      body: 'Something on our side stopped working. Your data is safe — nothing was changed. Try again in a moment.',
    },
    crash: {
      eyebrow: 'Our side',
      title: 'This page came off the board',
      body: 'The screen stopped responding and we cleared it rather than leave you with nothing. Your data is safe — nothing was saved or changed. Reloading should put it back.',
    },
    chunk: {
      eyebrow: 'Half delivered',
      title: 'Part of this page never turned up',
      body: 'A piece of the app didn’t finish loading, which usually means this tab has been open since before an update. A reload fetches the current version.',
    },
    maintenance: {
      eyebrow: 'Back shortly',
      title: 'The board is down for a tidy-up',
      body: 'We’re doing planned work, so this section is closed for a little while. Nothing has been lost — check back soon.',
    },
  }),

  /* ── The Campus Map ── navigational: corridors, rooms, directions. */
  map: Object.freeze({
    404: {
      eyebrow: 'Off the path',
      title: 'This hallway doesn’t exist yet',
      body: 'We followed the link as far as it goes and it stops short of anywhere. Whatever was here has been renamed or closed — your account is fine.',
    },
    403: {
      eyebrow: 'Checkpoint',
      title: 'There’s a steward on this corridor',
      body: 'This route is open to certain accounts only. Your school administrator can wave you through if you should be past here.',
    },
    expired: {
      eyebrow: 'Signed out',
      title: 'We stopped you at the last junction',
      body: 'Your session ended, so we went no further. Your data is safe — nothing was changed. Sign in again to pick up where you left off.',
    },
    offline: {
      eyebrow: 'Off the grid',
      title: 'The map runs out here',
      body: 'Your device has no connection, so nothing past this point has loaded. Your data is safe — anything you haven’t sent is still on this device, exactly as you left it. This page comes back on its own when the signal does.',
    },
  }),

  /* ── The Front Desk ── procedural: check-in, badges, stewards. */
  desk: Object.freeze({
    403: {
      eyebrow: 'Badge check',
      title: 'Your badge doesn’t open this one',
      body: 'This area is limited to certain accounts. If that looks wrong, your school administrator can change what your badge covers.',
    },
    expired: {
      eyebrow: 'Checked out',
      title: 'Your badge has been handed back',
      body: 'Your session ended while this page was open. Your data is safe — nothing was changed. Sign in again to carry on.',
    },
  }),

  /* ── The Ops Wall ── a coordinator's log: matter-of-fact, operational. */
  ops: Object.freeze({
    500: {
      eyebrow: 'Our side',
      title: 'One of our services stopped reporting',
      body: 'The rest of the system is running normally. Your data is safe — nothing was changed. Try again in a moment.',
    },
    crash: {
      eyebrow: 'Our side',
      title: 'This screen dropped off the wall',
      body: 'We caught the failure before it reached anything else. Your data is safe — nothing was saved or changed. Reloading should clear it.',
    },
    maintenance: {
      eyebrow: 'Scheduled',
      title: 'This one is paused on purpose',
      body: 'Planned work is under way, so a few things are switched off for now. Everything comes back without you doing anything.',
    },
  }),

  /* ── The Radio Room ── dispatch: contact, range, signal. */
  radio: Object.freeze({
    500: {
      eyebrow: 'Our side',
      title: 'We lost contact with one of our services',
      body: 'Everything else is still up. Your data is safe — nothing was changed. Try again shortly.',
    },
    chunk: {
      eyebrow: 'Broke up',
      title: 'That came through in pieces',
      body: 'Part of the app didn’t arrive, which usually means a tab left open across an update. A reload picks up the current version.',
    },
    offline: {
      eyebrow: 'No signal',
      title: 'Your device isn’t connected',
      body: 'We can’t reach the network from here. Your data is safe — anything you haven’t sent is still on this device. This page recovers on its own when the connection comes back.',
    },
    maintenance: {
      eyebrow: 'Off air',
      title: 'We’re off the air for a bit',
      body: 'Planned work is happening and we’re back as soon as it’s done. Nothing has been lost.',
    },
  }),

  /* ── The Club Fair ── the gym on sign-up day: booths, tables, bustle. */
  fair: Object.freeze({
    404: {
      eyebrow: 'Empty table',
      title: 'Nobody set up this booth',
      body: 'The link points at a stall that isn’t in the hall today. It may have closed or moved on — nothing is wrong with your account.',
    },
    maintenance: {
      eyebrow: 'Back shortly',
      title: 'This table is minding itself for a while',
      body: 'Planned work is happening and this part is closed for a short spell. Nothing has been lost — try again soon.',
    },
  }),
});

/**
 * Copy for a theme and kind, falling back to the board.
 *
 * Reached only when a theme is forced past its eligibility — the `theme` prop
 * used by tests and the dev preview. Rotation cannot produce this state, and a
 * test asserts every registered theme/kind pair has real copy, so this is a
 * safety net rather than a working code path.
 */
export function copyFor(themeId, kind) {
  return COPY[themeId]?.[kind] ?? COPY.board[kind] ?? COPY.board[404];
}
