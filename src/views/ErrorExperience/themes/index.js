import BoardScene from './BoardScene.jsx';
import MapScene from './MapScene.jsx';
import DeskScene from './DeskScene.jsx';
import OpsScene from './OpsScene.jsx';
import RadioScene from './RadioScene.jsx';
import FairScene from './FairScene.jsx';

/**
 * The theme registry: which scene explains which failure, and how.
 *
 * ── Eligibility is an honesty rule, not a variety rule ──
 *
 * A theme appears only where it is literally true about what happened. A radio
 * handset does not explain a permission refusal, and a gymnasium of club booths
 * is a tasteless way to report that the server fell over mid-signup. Letting
 * every theme answer every kind is what turns a rotation into one design
 * wearing six hats — the thing this system exists to avoid.
 *
 * The cost is accepted deliberately, and the table is uneven because of it:
 * `desk` answers two kinds and `board` answers six. The test asserts every kind
 * has at least ONE honest theme, not that the spread is fair.
 *
 * `offline` used to be the extreme case, with the radio as its only home. A
 * second was found rather than invented: a map whose far half never arrived is
 * what everyone with a phone has already seen the moment their signal dropped,
 * so it explains a lost connection without borrowing a metaphor. What was NOT
 * done is rotate an unrelated scene in for the sake of variety — seeing the
 * right picture twice beats seeing a dishonest one once.
 *
 * ── `modes` maps a kind to a scene's variant ──
 *
 * Scenes never see a status code. They are handed a mode — `gap`, `locked`,
 * `fault` — which is a statement about the picture, not about HTTP. That is
 * what keeps a scene a pure presentational component: it cannot branch on
 * something it should not know.
 *
 * ── One kind, one picture ──
 *
 * No theme may map two kinds to the same mode, and `selector.test.js` fails the
 * build on it. The first version of this table had `board` answering `500`,
 * `crash`, `chunk` and `maintenance` all with `rebuild`: six kinds, three
 * drawings, four cards in the contact sheet that were pixel-identical. Breadth
 * of rotation is worth nothing if the pictures repeat — a reader sees the same
 * drawing long before they read the headline meant to distinguish it, and the
 * whole system reads as one design wearing hats, which is the thing it exists
 * to avoid.
 *
 * `themes are statically imported`, never lazy: six small SVG components are
 * cheaper than the Suspense boundary needed to defer them, and a loading
 * flicker on an error page is the exact failure the rotation brief rules out.
 */

export const THEMES = Object.freeze([
  {
    id: 'board',
    name: 'The Bulletin Board',
    Scene: BoardScene,
    /* The universal fallback. Everything the product does eventually shows up
       as a sheet pinned to a board, so it can carry any kind without stretching
       — which is exactly what a fallback has to be able to do. */
    modes: Object.freeze({
      404: 'gap',
      403: 'locked',
      500: 'rebuild',
      crash: 'torn',
      chunk: 'partial',
      maintenance: 'notice',
    }),
  },
  {
    id: 'map',
    name: 'The Campus Map',
    Scene: MapScene,
    modes: Object.freeze({
      404: 'gap',
      403: 'blocked',
      expired: 'faded',
      offline: 'unmapped',
    }),
  },
  {
    id: 'desk',
    name: 'The Front Desk',
    Scene: DeskScene,
    modes: Object.freeze({
      403: 'locked',
      expired: 'expired',
    }),
  },
  {
    id: 'ops',
    name: 'The Ops Wall',
    Scene: OpsScene,
    modes: Object.freeze({
      500: 'fault',
      crash: 'dropped',
      maintenance: 'planned',
    }),
  },
  {
    id: 'radio',
    name: 'The Radio Room',
    Scene: RadioScene,
    modes: Object.freeze({
      500: 'partial',
      chunk: 'garbled',
      offline: 'silent',
      maintenance: 'scheduled',
    }),
  },
  {
    id: 'fair',
    name: 'The Club Fair',
    Scene: FairScene,
    modes: Object.freeze({
      404: 'empty',
      maintenance: 'closed',
    }),
  },
]);

/** The theme every fallback path lands on. Covers more kinds than any other. */
export const FALLBACK_THEME_ID = 'board';

export const THEME_IDS = Object.freeze(THEMES.map((t) => t.id));

export function getTheme(id) {
  return THEMES.find((t) => t.id === id);
}

/** Themes that can honestly explain `kind`, in registry order. */
export function themesForKind(kind) {
  return THEMES.filter((t) => Object.prototype.hasOwnProperty.call(t.modes, kind));
}
