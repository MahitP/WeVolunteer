/**
 * The fullscreen error experience.
 *
 * ── Why almost everything here is parameterised ──
 *
 * Six themes is six chances to reintroduce the bug this feature exists to fix:
 * a denied route that says nothing, or a page that leaks what broke. So the
 * behavioural claims are not asserted once against a convenient theme — they
 * run against EVERY theme, for every kind that theme is eligible for. A test
 * that passes only for the board is a test that will not notice theme seven.
 *
 * The wiring — that a denied route and an unknown path actually reach this — is
 * asserted in `App.routeTable.test.jsx` against the real router, which is a
 * different claim and the one that fails silently if the wiring is forgotten.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ErrorExperience, { crashFallback } from './ErrorExperience';
import { THEMES } from './themes/index.js';
import { KINDS, SERIOUS, RETRYABLE, weightFor } from './kinds';
import { COPY } from './errorCopy';
import { resetSeed } from './selector';
import Wordmark from '../../components/common/Wordmark';

const at = (props) =>
  render(<MemoryRouter><ErrorExperience {...props} /></MemoryRouter>);

/** Every (theme, kind) the rotation can actually produce. */
const PAIRS = THEMES.flatMap((t) => Object.keys(t.modes).map((kind) => [t.id, kind]));

beforeEach(() => resetSeed());
afterEach(() => vi.restoreAllMocks());

describe('every theme, for every kind it is eligible for', () => {
  it.each(PAIRS)('%s / %s renders a heading, a body and a way out', (theme, kind) => {
    at({ theme, kind });

    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent.trim().length).toBeGreaterThan(8);
    // The alert is labelled by the headline, so the announcement leads with it.
    expect(screen.getByRole('alert')).toHaveAttribute('aria-labelledby', h1.id);
    expect(screen.getAllByRole('link').length + screen.queryAllByRole('button').length)
      .toBeGreaterThan(0);
  });

  it.each(PAIRS)('%s / %s hides the artwork from assistive technology', (theme, kind) => {
    const { container } = at({ theme, kind });

    const scene = container.querySelector('.err-scene');
    expect(scene, 'no scene rendered').toBeTruthy();
    // The stage, not the svg, carries aria-hidden — so nothing decorative
    // escapes even if a scene later adds a sibling.
    const stage = container.querySelector('.err-stage');
    expect(stage.getAttribute('aria-hidden')).toBe('true');
    expect(stage.contains(scene)).toBe(true);
  });

  /**
   * The leak guard. A theme is markup, and markup is where a stack frame or a
   * path gets pasted "just while debugging".
   */
  it.each(PAIRS)('%s / %s leaks nothing internal', (theme, kind) => {
    const { container } = at({ theme, kind });
    const text = container.textContent;

    expect(text, 'leaked a path').not.toMatch(/\/(server|src|node_modules)\//);
    expect(text, 'leaked a stack frame').not.toMatch(/\bat .+:\d+:\d+/);
    expect(text, 'leaked SQL').not.toMatch(/SELECT |INSERT |sqlite/i);
    expect(text, 'leaked a status code').not.toMatch(/\b(404|403|500)\b/);
  });

  /**
   * Motion has to be reachable by the reduced-motion query, which an inline
   * animation is not. `--err-i` is a stagger index, not an animation, so
   * inline custom properties are fine — this asserts the specific thing that
   * would break the opt-out.
   */
  it.each(PAIRS)('%s / %s carries no inline animation', (theme, kind) => {
    const { container } = at({ theme, kind });
    for (const el of container.querySelectorAll('[style]')) {
      expect(el.getAttribute('style')).not.toMatch(/animation|transition/i);
    }
  });

  it.each(PAIRS)('%s / %s names the product', (theme, kind) => {
    at({ theme, kind });
    expect(screen.getByRole('img', { name: 'WeVolunteer' })).toBeInTheDocument();
  });
});

/**
 * Weight is severity, and getting it wrong is a design failure in both
 * directions: a viewport takeover to say "ask your administrator" is melodrama
 * that hides the very navigation the reader needs next, and a modest card when
 * the server is down reads as not understanding what just happened to them.
 *
 * Asserted against the WEIGHTS table rather than restated here — a second copy
 * of the mapping would agree with itself and with nothing else. What is pinned
 * literally is the part that must not drift silently: which kinds are allowed
 * to own the screen.
 */
describe('weight matches severity', () => {
  it.each(KINDS.map((k) => [k]))('%s carries its declared weight', (kind) => {
    const { container } = at({ kind, theme: 'board' });
    expect(container.querySelector('.err').dataset.errorWeight).toBe(weightFor(kind));
  });

  /**
   * `404` and `expired` joined this tier when the middle weight was removed.
   * Both are takeovers for the same reason: the shell is no help with either.
   * A dead URL is not something the navigation can fix, and an expired session
   * has no shell to sit in — the reader is signed out.
   *
   * `403` joined last, and it joined because the code had already moved without
   * this table — see the test below.
   */
  it('gives the whole screen to the failures that deserve it, and no others', () => {
    const immersive = KINDS.filter((k) => weightFor(k) === 'immersive');
    expect([...immersive].sort()).toEqual(
      ['403', '404', '500', 'chunk', 'crash', 'expired', 'maintenance', 'offline']
    );
  });

  /**
   * The drift this test exists to stop happening again.
   *
   * `App.jsx` returns `<ErrorExperience kind="403" />` BEFORE it builds the
   * shell — the same early return the 404 takes, added when the refusal was
   * deliberately promoted to a takeover ("it reads as a page that failed to
   * load rather than a decision, and it leaves the nav for a section the reader
   * has just been told they cannot open").
   *
   * `WEIGHTS` was never updated with it, so for a while the 403 rendered at the
   * top level wearing the sizing meant for a card inside a shell: `min-height:
   * 0` and a 0.64× scene on an empty viewport, which put the whole composition
   * in the top-left corner above about 55% dead space, with a visible seam where
   * the clipped background wash ended.
   *
   * Pinning it to the 404 rather than to the literal string is the point. These
   * two are the same situation — a URL this reader cannot be shown, decided
   * before the shell exists — so if one is ever re-tiered the other has to move
   * with it, and this fails until it does.
   */
  it('sizes a refusal exactly like the 404, because both are decided before the shell', () => {
    expect(weightFor('403')).toBe(weightFor('404'));
    expect(weightFor('403')).toBe('immersive');
  });

  /**
   * Every kind is a takeover today. That is a real statement about the product —
   * there is no failure this app renders as a card in a working shell — and it
   * is worth failing on, because adding a non-takeover kind means writing the
   * CSS for it, which no longer exists.
   */
  it('has no kind that renders inside a shell', () => {
    expect(KINDS.filter((k) => weightFor(k) !== 'immersive')).toEqual([]);
  });

  /**
   * The default is the LOUD one. An unclassified kind has already gone wrong
   * somewhere; too large wastes a screen, too small buries a failure nobody has
   * looked at yet.
   */
  it('falls back to the takeover weight for a kind nobody registered', () => {
    expect(weightFor('teapot')).toBe('immersive');
    const { container } = at({ kind: 'teapot' });
    expect(container.querySelector('.err').dataset.errorWeight).toBe('immersive');
  });
});

describe('every experience is unmistakably WeVolunteer', () => {
  it.each(PAIRS)('%s / %s carries the wordmark, named once', (theme, kind) => {
    const { container } = at({ theme, kind });
    const mark = container.querySelector('.err-mark');

    expect(mark.querySelector('svg.wordmark'), 'no wordmark — the screen does not say whose it is').toBeTruthy();
    // The wordmark's W is the mark. A tile beside it would print the W twice,
    // and a second name would announce the product twice.
    expect(mark.querySelector('.brand-mark')).toBeNull();
    expect(mark.querySelectorAll('[role="img"], [aria-label]')).toHaveLength(1);
    expect(mark.textContent).toBe('');
  });

  /**
   * The same component the app shell and the certificate page render. A second
   * hand-written copy of the markup is how one surface keeps the old mark after
   * the others change — and the error screens, which nobody opens on purpose,
   * are exactly the surface that gets forgotten.
   */
  it('uses the shared wordmark rather than its own copy of the markup', () => {
    const { container } = render(<MemoryRouter><Wordmark /></MemoryRouter>);
    const shared = container.querySelector('.wordmark');
    const { container: err } = at({ kind: '404', theme: 'board' });
    const inError = err.querySelector('.err-mark .wordmark');

    expect(inError.outerHTML).toBe(shared.outerHTML);
  });
});

describe('the way out matches the session and the kind', () => {
  it('offers in-app links to someone signed in', () => {
    at({ kind: '404', theme: 'board' });
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /browse open shifts/i })).toHaveAttribute('href', '/discover');
  });

  /**
   * A signed-out visitor sent to `/discover` is bounced straight back, which
   * would make the page look broken in the moment it is trying to help.
   */
  it('offers only the start page to someone signed out', () => {
    at({ kind: '404', signedIn: false, theme: 'board' });
    expect(screen.getByRole('link', { name: /start page/i })).toHaveAttribute('href', '/welcome');
    expect(screen.queryByRole('link', { name: /browse open shifts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dashboard/i })).not.toBeInTheDocument();
  });

  it('does not offer "browse open shifts" on a permission refusal', () => {
    at({ kind: '403', theme: 'board' });
    expect(screen.queryByRole('link', { name: /browse open shifts/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
  });

  it('sends an expired session to sign in again, not to a dashboard it cannot load', () => {
    at({ kind: 'expired', theme: 'desk' });
    expect(screen.getByRole('link', { name: /sign in again/i })).toHaveAttribute('href', '/welcome');
    expect(screen.queryByRole('link', { name: /dashboard/i })).not.toBeInTheDocument();
  });

  it.each(KINDS.map((k) => [k]))('offers a retry on %s only when retrying helps', (kind) => {
    // Force the fallback theme so every kind is renderable from one place.
    at({ kind, theme: 'board' });
    const retry = screen.queryByRole('button', { name: /try again/i });
    expect(Boolean(retry), `${kind} retry affordance`).toBe(RETRYABLE.includes(kind));
  });

  it('calls onRetry instead of reloading when the caller supplies one', () => {
    // The boundary passes its own reset here, so recovering from a caught
    // render error must not cost a full page load.
    let called = 0;
    at({ kind: 'crash', theme: 'board', onRetry: () => { called += 1; } });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(called).toBe(1);
  });

  /**
   * No error id, deliberately: a code the reader cannot use is noise, and
   * asking a fourteen-year-old to quote a UUID is not a support process. The
   * server already has the fingerprint.
   */
  it('shows no error code or identifier', () => {
    const { container } = at({ kind: '500', theme: 'ops' });
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(container.textContent).not.toMatch(/error id|reference|code:/i);
  });
});

describe('rotation is stable and honest', () => {
  it('renders a theme eligible for the kind when none is forced', () => {
    for (const kind of KINDS) {
      const { container, unmount } = at({ kind });
      const chosen = container.querySelector('.err').dataset.errorTheme;
      const theme = THEMES.find((t) => t.id === chosen);
      expect(theme, `${kind} chose an unknown theme`).toBeTruthy();
      expect(
        Object.keys(theme.modes),
        `${chosen} is not eligible for ${kind}`
      ).toContain(kind);
      unmount();
    }
  });

  it('does not reshuffle when the same component re-renders', () => {
    const view = render(<MemoryRouter><ErrorExperience kind="404" /></MemoryRouter>);
    const first = view.container.querySelector('.err').dataset.errorTheme;
    view.rerender(<MemoryRouter><ErrorExperience kind="404" /></MemoryRouter>);
    expect(view.container.querySelector('.err').dataset.errorTheme).toBe(first);
  });

  /**
   * Pinning the theme in a `useState` initialiser froze it for the life of the
   * instance, so a prop change repainted nothing. Seen in a browser: moving the
   * dev gallery from `radio/offline` to `ops/500` client-side kept the RADIO
   * handset on screen with the radio's words, and only a hard reload agreed
   * with the URL. In the app the same instance can be handed a new kind when a
   * boundary is reused across routes, and the result is worse than stale — the
   * copy comes from the live kind while the picture comes from the dead one, so
   * a permission refusal can be narrated over a server-fault scene.
   *
   * `useMemo` is also the simpler answer: `selectTheme` is deterministic given
   * a seed that is already persisted, so nothing is being protected by holding
   * the value in state.
   */
  it('follows the kind when it changes rather than freezing at the first one', () => {
    const view = render(<MemoryRouter><ErrorExperience kind="403" theme="desk" /></MemoryRouter>);
    const before = view.container.querySelector('.err').dataset;
    expect(before.errorKind).toBe('403');
    expect(before.errorTheme).toBe('desk');

    view.rerender(<MemoryRouter><ErrorExperience kind="500" theme="ops" /></MemoryRouter>);
    const after = view.container.querySelector('.err').dataset;
    expect(after.errorKind).toBe('500');
    expect(after.errorTheme, 'the scene is still the previous kind’s').toBe('ops');
    // The picture and the words have to move together.
    expect(view.container.querySelector('.err-scene').classList).toContain('err-ops');
    expect(screen.getByRole('heading', { level: 1 }).textContent)
      .toBe(COPY.ops[500].title);
  });

  it('exposes the kind for routing tests without printing it to the reader', () => {
    const { container } = at({ kind: '403', theme: 'map' });
    const root = container.querySelector('.err');
    expect(root.dataset.errorKind).toBe('403');
    // The attribute is a test seam, not copy. A status code in front of a
    // reader who cannot act on it is the thing this system refuses to show.
    expect(root.textContent).not.toContain('403');
  });

  it('falls back rather than rendering nothing for an unknown kind', () => {
    at({ kind: 'teapot' });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('falls back rather than rendering nothing for an unknown theme', () => {
    at({ kind: '404', theme: 'no-such-theme' });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  /**
   * Forcing a theme past its eligibility is only reachable from tests and the
   * dev preview, but it must degrade rather than throw — an error page that
   * crashes is the worst possible failure in the system.
   */
  it('survives a theme forced onto a kind it has no copy or mode for', () => {
    const { container } = at({ kind: 'offline', theme: 'fair' });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(container.querySelector('.err-scene')).toBeTruthy();
  });
});

/**
 * The boundary fallback both fullscreen boundaries share.
 *
 * The distinction it makes is invisible in a screenshot and load-bearing for
 * anyone whose tab has fallen behind a release: `reset` re-renders the same
 * lazy import that just failed, so for a chunk it re-throws immediately and the
 * "Try again" button does nothing at all.
 */
describe('crashFallback', () => {
  const render_ = (arg) => render(<MemoryRouter>{crashFallback(arg)}</MemoryRouter>);

  it('calls the boundary’s reset for an ordinary render error', () => {
    let reset = 0;
    render_({ error: new Error('event.slots is not iterable'), reset: () => { reset += 1; } });
    expect(screen.getByRole('alert').dataset.errorKind).toBe('crash');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toBe(1);
  });

  it('reloads instead of resetting when the bundle is the thing that is missing', () => {
    let reset = 0;
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ reload });

    render_({
      error: new Error('Failed to fetch dynamically imported module: /assets/Settings-x.js'),
      reset: () => { reset += 1; },
    });
    expect(screen.getByRole('alert').dataset.errorKind).toBe('chunk');

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reload, 'a chunk failure must fetch the current release').toHaveBeenCalledTimes(1);
    expect(reset, 'reset re-renders the same missing import and re-throws').toBe(0);
  });
});

describe('the heading is unique per instance', () => {
  /**
   * `useId` rather than a constant: the authenticated catch-all and a boundary
   * fallback can both be mounted, and two elements sharing an id would make
   * `aria-labelledby` point at whichever the browser found first.
   */
  it('gives two mounted experiences different heading ids', () => {
    const { container } = render(
      <MemoryRouter>
        <ErrorExperience kind="404" theme="board" />
        <ErrorExperience kind="500" theme="ops" />
      </MemoryRouter>
    );
    const [a, b] = [...container.querySelectorAll('.err')];
    const idA = within(a).getByRole('heading', { level: 1 }).id;
    const idB = within(b).getByRole('heading', { level: 1 }).id;
    expect(idA).not.toBe(idB);
    expect(a.getAttribute('aria-labelledby')).toBe(idA);
    expect(b.getAttribute('aria-labelledby')).toBe(idB);
  });
});

describe('serious failures are not played for laughs', () => {
  it.each(SERIOUS.map((k) => [k]))('%s reassures about data in every eligible theme', (kind) => {
    const eligible = THEMES.filter((t) => kind in t.modes);
    expect(eligible.length, `${kind} has no theme`).toBeGreaterThan(0);

    for (const theme of eligible) {
      const { container, unmount } = at({ kind, theme: theme.id });
      expect(
        container.textContent,
        `${theme.id}/${kind} does not say the data is safe`
      ).toMatch(/safe/i);
      unmount();
    }
  });
});
