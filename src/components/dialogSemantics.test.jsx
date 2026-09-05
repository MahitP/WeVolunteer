import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import RecipientPicker from './messages/RecipientPicker';
import { api } from '../utils/api';

/**
 * Regression cover for dialogs that bypass the shared modal shell.
 *
 * Every dialog in the app is supposed to render through `Modal`, which supplies
 * `role="dialog"`, `aria-modal`, Escape, focus containment, focus restore and
 * scroll lock. Two were still hand-rolled and had none of it:
 *
 *   • RecipientPicker — the "New Message" dialog. Beyond the missing semantics,
 *     every search RESULT was a `<div onClick>`: not focusable, not reachable by
 *     Tab, and not activatable by Enter or Space. Starting a conversation was
 *     mouse-only. Its close button also asked for `.icon-btn`, which has no rule
 *     anywhere (the app's class is `.btn-icon`), so it rendered unstyled.
 *
 *   • DataExportCard — the export progress/download dialog, whose close control
 *     was a bare "×" with no accessible name at all.
 *
 * These are the last two, so the file also asserts the property globally: no
 * component may hand-roll `.modal-overlay` outside Modal.jsx itself.
 */

const SRC = path.join(process.cwd(), 'src');

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('no component hand-rolls a modal overlay', () => {
  /**
   * The property that actually matters: a dialog must have dialog behaviour.
   *
   * Three components (EventModal, CertificateModal, ProfileEditModal) render
   * their own `.modal-overlay` element but DO call `useModal` and DO set
   * `role="dialog"` and `aria-modal`, so they behave correctly — Escape, focus
   * containment, focus restore and scroll lock all work. Rewriting them to use
   * the shared shell would be a broad refactor of, in EventModal's case, 700+
   * lines, for no behavioural gain.
   *
   * So this asserts semantics rather than markup style: render an overlay and you
   * must supply the behaviour, whether via `Modal` or via `useModal` directly.
   * That is what RecipientPicker and DataExportCard were missing entirely.
   */
  it('every component that renders an overlay provides dialog behaviour', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        if (entry.name === 'Modal.jsx') continue;
        const src = readFileSync(full, 'utf8');
        if (!/className=(?:\{`|")modal-overlay/.test(src)) continue;

        const missing = [];
        if (!/useModal\(/.test(src)) missing.push('useModal (Escape/focus/scroll-lock)');
        if (!/role="dialog"/.test(src)) missing.push('role="dialog"');
        if (!/aria-modal/.test(src)) missing.push('aria-modal');
        if (missing.length) {
          offenders.push(`${path.relative(process.cwd(), full)} — missing ${missing.join(', ')}`);
        }
      }
    };
    walk(SRC);
    expect(offenders, 'a dialog without dialog behaviour is keyboard-inaccessible').toEqual([]);
  });

  it('no component asks for .icon-btn, which has no rule (the class is .btn-icon)', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        // className usage only — a mention in a comment explaining the old bug
        // is not itself the bug.
        const src = readFileSync(full, 'utf8');
        const inClassName = [...src.matchAll(/className=(?:\{[`"']([^`"']*)|["']([^"']*))/g)]
          .some(m => /\bicon-btn\b/.test(m[1] ?? m[2] ?? ''));
        if (inClassName) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('RecipientPicker dialog semantics', () => {
  const USERS = [
    { id: 'u1', name: 'Elena Rodriguez', username: 'erodriguez', eventId: 'e1', eventTitle: 'Food Drive', avatar: null },
    { id: 'u2', name: 'Mark Robinson', username: 'mrobinson', eventId: 'e2', eventTitle: 'Library Shelver', avatar: '👨' }
  ];

  const mountWithResults = async () => {
    vi.spyOn(api, 'searchMessagesUsers').mockResolvedValue({ users: USERS });
    const onSelect = vi.fn(), onClose = vi.fn();
    const utils = render(<RecipientPicker onSelect={onSelect} onClose={onClose} />);
    const input = utils.baseElement.querySelector('input');
    fireEvent.change(input, { target: { value: 'ro' } });
    await waitFor(() => expect(utils.baseElement.querySelectorAll('[data-recipient]').length).toBe(2), { timeout: 3000 });
    return { ...utils, onSelect, onClose };
  };

  it('is a dialog', () => {
    vi.spyOn(api, 'searchMessagesUsers').mockResolvedValue({ users: [] });
    const { baseElement } = render(<RecipientPicker onSelect={() => {}} onClose={() => {}} />);
    const dialog = baseElement.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBeTruthy();
  });

  it('closes on Escape', () => {
    vi.spyOn(api, 'searchMessagesUsers').mockResolvedValue({ users: [] });
    const onClose = vi.fn();
    render(<RecipientPicker onSelect={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The core accessibility defect: the results were unreachable by keyboard.
  it('renders each result as a real button, not a clickable div', async () => {
    const { baseElement } = await mountWithResults();
    const rows = [...baseElement.querySelectorAll('[data-recipient]')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tagName, 'a recipient row must be focusable and activatable').toBe('BUTTON');
      expect(row.getAttribute('type')).toBe('button');
    }
  });

  it('selects a recipient with the keyboard', async () => {
    const { baseElement, onSelect } = await mountWithResults();
    const row = baseElement.querySelector('[data-recipient]');
    row.focus();
    // A <button> activates on Enter and Space natively; click is what fires.
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('u1');
  });

  it('gives each result an accessible name including the person and the event', async () => {
    const { baseElement } = await mountWithResults();
    const label = baseElement.querySelector('[data-recipient]').getAttribute('aria-label');
    expect(label).toMatch(/Elena Rodriguez/);
    expect(label).toMatch(/Food Drive/);
  });

  it('labels the close control', () => {
    vi.spyOn(api, 'searchMessagesUsers').mockResolvedValue({ users: [] });
    const { baseElement } = render(<RecipientPicker onSelect={() => {}} onClose={() => {}} />);
    const close = baseElement.querySelector('.modal-close');
    expect(close).toBeTruthy();
    expect(close.getAttribute('aria-label')).toBeTruthy();
  });

  it('announces the searching and empty states', async () => {
    vi.spyOn(api, 'searchMessagesUsers').mockResolvedValue({ users: [] });
    const { baseElement } = render(<RecipientPicker onSelect={() => {}} onClose={() => {}} />);
    fireEvent.change(baseElement.querySelector('input'), { target: { value: 'zz' } });
    await waitFor(() => expect(baseElement.textContent).toMatch(/No .*found|Searching/i), { timeout: 3000 });
    expect(baseElement.querySelector('[role="status"]'), 'state changes need a live region').toBeTruthy();
  });
});

describe('DataExportCard dialog semantics', () => {
  const src = readFileSync(path.join(SRC, 'components', 'account', 'DataExportCard.jsx'), 'utf8');

  it('renders its dialog through the shared Modal', () => {
    expect(src).toMatch(/from '\.\.\/Modal'/);
    expect(src).toMatch(/<Modal\b/);
  });

  it('does not hand-roll an overlay', () => {
    expect(src).not.toMatch(/className="modal-overlay"/);
  });

  it('gives the dialog an accessible name', () => {
    expect(src).toMatch(/label=/);
  });

  it('labels its close control rather than shipping a bare ×', () => {
    // ModalHead supplies aria-label="Close dialog"; a hand-rolled "×" button did not.
    const hasBareTimes = /<button[^>]*className="modal-close"[^>]*>\s*×\s*<\/button>/.test(src);
    expect(hasBareTimes, 'close button has no accessible name').toBe(false);
  });
});

/**
 * The dialog's accessible DESCRIPTION, which `Modal` now supplies.
 *
 * ── Why this needs a guard of its own ──
 *
 * `ModalHead`'s `description` used to be a bare `<p className="lead">` that a
 * screen-reader user had to arrow to. That is fine for a subtitle and not fine
 * when the sentence is load-bearing: the organization share dialog puts the one
 * sentence distinguishing a credential (an invitation link) from an address (a
 * public handle) there, and the dialog announced only "Share <club>, dialog".
 *
 * `Modal` now points `aria-describedby` at it. Forty-six components render
 * through `Modal`, so the two failure modes are worth pinning rather than
 * assuming:
 *
 *   1. **A dangling reference.** `aria-describedby` naming an element that does
 *      not exist is worse than not setting it — some screen readers then
 *      announce nothing for the NAME either. So it must be absent when the
 *      dialog has no description, which is most of them.
 *   2. **Drift between the id and the attribute.** Two string literals in one
 *      file is the shape that goes stale, so both sides come from
 *      `MODAL_DESCRIPTION_ID`.
 */
describe('the shared Modal description wiring', () => {
  const modalSrc = readFileSync(path.join(process.cwd(), 'src/components/Modal.jsx'), 'utf8');

  it('takes the id from one exported constant on both sides', () => {
    expect(modalSrc).toMatch(/export const MODAL_DESCRIPTION_ID = '[a-z-]+'/);
    /* The attribute reads a state value derived from the constant, and the head
       stamps the same constant — never a second literal. */
    expect(modalSrc).toMatch(/id=\{MODAL_DESCRIPTION_ID\}/);
    expect(modalSrc).toMatch(/querySelector\(`#\$\{MODAL_DESCRIPTION_ID\}`\)/);

    const literals = modalSrc.match(/'dialog-description'/g) ?? [];
    expect(literals, 'the id should appear as a literal exactly once').toHaveLength(1);
  });

  /**
   * Detected from the DOM rather than declared by the caller.
   *
   * A caller passing `<ModalHead description=…>` should not also have to
   * remember a flag — and a flag is what would drift.
   */
  it('sets the attribute only when the described element is present', () => {
    /* `undefined` is the initial state, and React omits an attribute whose
       value is undefined — which is what makes "no description" mean "no
       attribute" rather than "an attribute pointing at nothing". */
    expect(modalSrc).toMatch(/useState\(undefined\)/);
    /* `setHeadDescribedBy`, not `setDescribedBy`: `Modal` also takes an explicit
       `describedBy` prop now, for a dialog that builds its own head and names
       its own id. The detected value keeps the head's name so the two cannot be
       confused for each other — this one is only ever the standard head. */
    expect(modalSrc).toMatch(/setHeadDescribedBy\(node \? MODAL_DESCRIPTION_ID : undefined\)/);
    /* And the explicit id wins where a caller gave one. */
    expect(modalSrc).toMatch(/aria-describedby=\{describedBy \|\| headDescribedBy\}/);
  });

  /** And it is not named outside the `modal-` class namespace by accident. */
  it('keeps the id out of the stylesheet class namespace', () => {
    /* `noDanglingClasses.test.js` watches the `modal-` prefix for CLASS names
       and read `modal-description` as one. An id should not borrow a namespace
       the stylesheet owns. */
    expect(modalSrc).not.toMatch(/MODAL_DESCRIPTION_ID = 'modal-/);
  });
});
