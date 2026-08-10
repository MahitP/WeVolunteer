/**
 * Saving recovery codes, and — more importantly — where they must not go.
 *
 * ── What is actually at risk here ──
 *
 * A recovery code is a bearer credential that completes a second factor. The
 * export exists so somebody can keep one, and every convenient way to build a
 * download is a way to put the credential somewhere it outlives the page:
 *
 *   - a `data:` URL carries the payload IN the URL, so it lands in browser
 *     history and in anything watching navigation;
 *   - a server round trip to render a file sends the codes back to the server
 *     that just generated them, over a request that gets logged;
 *   - an analytics or error-reporting call made from the same handler can
 *     capture the arguments it was given.
 *
 * So the assertions below are as much about what is NOT called as about the file
 * that comes out: no `fetch`, no `XMLHttpRequest`, no `sendBeacon`, no `data:`
 * URL, nothing written to storage, and no code in any URL the page ever creates.
 *
 * jsdom implements neither `canvas.getContext` nor `toBlob`, so the PNG path
 * runs against a recorded stub. That is the right level for this file: what is
 * being checked is that the codes are drawn from memory and handed to the same
 * blob-download path, not that a particular pixel is green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recoveryCodesAsText, downloadRecoveryCodesTxt, downloadRecoveryCodesPng,
} from './recoveryCodeExport';

const CODES = ['AAAA-1111', 'BBBB-2222', 'CCCC-3333'];

let created, revoked, clicked, drawnText;

/** Records every object URL the module makes, and every download it triggers. */
function install({ withCanvas = false, contextIsNull = false } = {}) {
  created = [];
  revoked = [];
  clicked = [];
  drawnText = [];

  global.URL.createObjectURL = vi.fn((blob) => {
    created.push(blob);
    return `blob:mock/${created.length}`;
  });
  global.URL.revokeObjectURL = vi.fn((url) => revoked.push(url));

  /* An anchor whose click is recorded rather than performed — jsdom would
     otherwise try to navigate. */
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    const el = realCreate(tag);
    if (tag === 'a') {
      el.click = () => clicked.push({ href: el.href, download: el.download });
    }
    if (tag === 'canvas' && contextIsNull) {
      el.getContext = () => null;
    } else if (tag === 'canvas' && withCanvas) {
      el.getContext = () => ({
        scale: () => {}, fillRect: () => {}, beginPath: () => {}, fill: () => {},
        roundRect: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
        fillText: (t) => drawnText.push(String(t)),
        set fillStyle(_v) {}, set font(_v) {}, set textBaseline(_v) {}, set strokeStyle(_v) {},
      });
      el.toBlob = (cb) => cb(new Blob(['png'], { type: 'image/png' }));
    }
    return el;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the text the two formats share', () => {
  it('contains every code, once each', () => {
    const text = recoveryCodesAsText(CODES);
    for (const code of CODES) {
      expect(text.split(code)).toHaveLength(2);
    }
  });

  /* A file found in a downloads folder eighteen months later has to explain
     itself: what it is, that each code works once, and when it was saved. */
  it('explains what the file is, and when it was saved', () => {
    const text = recoveryCodesAsText(CODES, { now: new Date('2026-08-09T12:00:00.000Z') });
    expect(text).toContain('WeVolunteer recovery codes');
    expect(text).toContain('ONCE');
    expect(text).toContain('2026-08-09');
  });

  it('is stable — the same codes produce the same file', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    expect(recoveryCodesAsText(CODES, { now })).toBe(recoveryCodesAsText(CODES, { now }));
  });
});

describe('the .txt download', () => {
  beforeEach(() => install());

  it('builds a text blob and downloads it under a dated name', () => {
    downloadRecoveryCodesTxt(CODES);
    expect(created).toHaveLength(1);
    expect(created[0].type).toMatch(/^text\/plain/);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('wevolunteer-recovery-codes-2026-08-09.txt');
  });

  /**
   * The URL is a `blob:` reference to local memory. A `data:` URL would carry
   * the codes themselves in the address, which is the one place they must never
   * be — it is recorded in history and visible to anything watching navigation.
   */
  it('never puts a code in the URL', () => {
    downloadRecoveryCodesTxt(CODES);
    expect(clicked[0].href).toMatch(/^blob:/);
    expect(clicked[0].href).not.toMatch(/^data:/);
    for (const code of CODES) expect(clicked[0].href).not.toContain(code);
  });

  /* Revoked, but on a later tick: Safari cancels an in-flight download if the
     URL is revoked in the same task. */
  it('revokes the object URL, after the download has started', () => {
    downloadRecoveryCodesTxt(CODES);
    expect(revoked).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(revoked).toEqual(['blob:mock/1']);
  });

  it('leaves no anchor behind in the document', () => {
    downloadRecoveryCodesTxt(CODES);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});

describe('the .png download', () => {
  beforeEach(() => install({ withCanvas: true }));

  it('draws every code and downloads a PNG', async () => {
    await downloadRecoveryCodesPng(CODES);
    for (const code of CODES) expect(drawnText).toContain(code);
    expect(created[0].type).toBe('image/png');
    expect(clicked[0].download).toBe('wevolunteer-recovery-codes-2026-08-09.png');
    expect(clicked[0].href).toMatch(/^blob:/);
  });

  /* The image has to explain itself too — it is the format most likely to be
     found in a camera roll with no filename in view. */
  it('draws the heading and the instructions, not just the codes', async () => {
    await downloadRecoveryCodesPng(CODES);
    expect(drawnText.join('\n')).toContain('WeVolunteer recovery codes');
    expect(drawnText.join('\n')).toMatch(/ONCE/);
    /* And the brand mark, drawn rather than fetched: this must work on a page
       that has just told somebody to write something down offline. */
    expect(drawnText).toContain('WV');
  });

  /**
   * `toBlob` may legitimately yield null, and a browser may have no 2D context
   * at all. Both must reject so the caller can say "copy them down instead"
   * rather than silently saving nothing.
   */
  it('rejects rather than failing silently when the canvas cannot produce one', async () => {
    /* A browser with no 2D context. The promise must reject so the caller can
       say "copy them down instead" rather than silently saving nothing. */
    vi.restoreAllMocks();
    install({ contextIsNull: true });
    await expect(downloadRecoveryCodesPng(CODES)).rejects.toThrow(/cannot generate/i);
    expect(clicked).toHaveLength(0);
  });
});

describe('nothing leaves the browser', () => {
  beforeEach(() => install({ withCanvas: true }));

  it('makes no network call of any kind', async () => {
    const fetchSpy = vi.fn();
    const beaconSpy = vi.fn();
    global.fetch = fetchSpy;
    navigator.sendBeacon = beaconSpy;
    const xhrOpen = vi.spyOn(window.XMLHttpRequest.prototype, 'open');

    downloadRecoveryCodesTxt(CODES);
    await downloadRecoveryCodesPng(CODES);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
  });

  /* Not to localStorage, not to sessionStorage, and not to a cookie. A recovery
     code left in storage outlives the one screen it was shown on. */
  it('writes nothing to storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    downloadRecoveryCodesTxt(CODES);
    await downloadRecoveryCodesPng(CODES);
    expect(local).not.toHaveBeenCalled();
    for (const code of CODES) expect(document.cookie).not.toContain(code);
  });

  it('logs nothing containing a code', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug']
      .map(k => vi.spyOn(console, k).mockImplementation(() => {}));
    downloadRecoveryCodesTxt(CODES);
    await downloadRecoveryCodesPng(CODES);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const said = call.map(String).join(' ');
        for (const code of CODES) expect(said).not.toContain(code);
      }
    }
  });

  /* The document's own URL is never touched — a code in the address bar would
     land in history and in any referer the page later sends. */
  it('does not change the address bar', async () => {
    const before = window.location.href;
    downloadRecoveryCodesTxt(CODES);
    await downloadRecoveryCodesPng(CODES);
    expect(window.location.href).toBe(before);
  });
});
