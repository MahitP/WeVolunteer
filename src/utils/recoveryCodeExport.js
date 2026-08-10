/**
 * Saving recovery codes, as a text file or as an image.
 *
 * ── Why an image at all ──
 *
 * Recovery codes are shown once, on the screen a person is most likely to be
 * holding a phone in front of. A `.txt` download on a phone lands somewhere
 * awkward — a Files app most students never open again — whereas an image goes
 * to the camera roll, which is the place they already keep things they need to
 * find later. Both are offered because neither is right for everybody: on a
 * desktop the text file is obviously better, and it is the one that can be
 * pasted into a password manager.
 *
 * ── Where these codes must never go ──
 *
 * Everything here runs entirely in the browser. The codes are drawn to a canvas
 * and built into a Blob from values already in React state; nothing is fetched,
 * nothing is posted, no URL ever carries a code, and no analytics or logging
 * call is made. A recovery code in a URL would land in browser history and in
 * any proxy log between here and nowhere — so the object URL created below is a
 * `blob:` reference to local memory, and it is revoked immediately after use.
 */

/** Rendered at the top of both formats, so a file found later explains itself. */
const HEADING = 'WeVolunteer recovery codes';

const BODY_LINES = [
  'Each code works ONCE. Use one if you cannot reach your',
  'authenticator app or your email.',
  'Keep this somewhere only you can read.',
];

/**
 * Triggers a download without ever putting the payload in a URL bar.
 *
 * `blob:` plus a synthetic click is the only approach that works across
 * desktop and mobile browsers without a server round trip. `revokeObjectURL`
 * runs on the next tick rather than immediately: Safari cancels an in-flight
 * download if the URL is revoked in the same task.
 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `wevolunteer-recovery-codes-2026-08-09.txt` — dated, so two saves do not collide. */
function filename(extension) {
  const day = new Date().toISOString().slice(0, 10);
  return `wevolunteer-recovery-codes-${day}.${extension}`;
}

/** The plain-text form. Also what the image renders, so the two cannot drift. */
export function recoveryCodesAsText(codes, { now = new Date() } = {}) {
  return [
    HEADING,
    `Saved ${now.toISOString().slice(0, 10)}`,
    '',
    ...BODY_LINES,
    '',
    ...codes.map(code => `  ${code}`),
    '',
  ].join('\n');
}

export function downloadRecoveryCodesTxt(codes) {
  const blob = new Blob([recoveryCodesAsText(codes)], { type: 'text/plain;charset=utf-8' });
  saveBlob(blob, filename('txt'));
}

/**
 * Draws the codes to a canvas and saves it as a PNG.
 *
 * Deliberately light-on-dark-agnostic: the image is drawn with its own fixed
 * white background and near-black text rather than reading the app's theme
 * tokens. A screenshot saved to a camera roll is looked at in a photo viewer
 * that knows nothing about `data-theme`, and a dark-mode export would be a page
 * of dark grey on darker grey the first time somebody prints it.
 *
 * Rendered at 2× and scaled down by CSS pixel ratio so the digits stay sharp on
 * a phone screen, where this is most likely to be read back from.
 *
 * Returns a Promise so a caller can await the save and report failure — canvas
 * `toBlob` is asynchronous and can legitimately yield null.
 */
export function downloadRecoveryCodesPng(codes) {
  return new Promise((resolve, reject) => {
    const SCALE = 2;
    const PAD = 40;
    const LINE = 26;
    const CODE_LINE = 34;
    const WIDTH = 520;

    const headerLines = 2 + BODY_LINES.length + 1;
    const height = PAD * 2 + LINE * (headerLines + 1) + CODE_LINE * codes.length;

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = height * SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('This browser cannot generate the image.')); return; }
    ctx.scale(SCALE, SCALE);

    /* Fixed colours, for the reason in the docstring above. */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, height);

    /* The brand tile, drawn rather than loaded: an <img> would need a network
       fetch, and this function must work on a page that has just told the user
       to write something down offline. */
    ctx.fillStyle = '#0f6b45';
    ctx.beginPath();
    ctx.roundRect(PAD, PAD - 6, 34, 34, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('WV', PAD + 6, PAD + 11);

    let y = PAD + 12;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 19px Helvetica, Arial, sans-serif';
    ctx.fillText(HEADING, PAD + 46, y);

    y += LINE;
    ctx.fillStyle = '#555555';
    ctx.font = '13px Helvetica, Arial, sans-serif';
    ctx.fillText(`Saved ${new Date().toISOString().slice(0, 10)}`, PAD, y);

    y += LINE * 0.6;
    for (const line of BODY_LINES) {
      y += LINE * 0.8;
      ctx.fillText(line, PAD, y);
    }

    y += LINE * 0.8;
    ctx.strokeStyle = '#dddddd';
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(WIDTH - PAD, y);
    ctx.stroke();

    /* Monospace, because a recovery code is read back one character at a time
       and a proportional font makes 0/O and 1/l a guess. */
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 20px "SFMono-Regular", Menlo, Consolas, monospace';
    y += 14;
    for (const code of codes) {
      y += CODE_LINE;
      ctx.fillText(code, PAD, y);
    }

    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('This browser could not save the image.')); return; }
      saveBlob(blob, filename('png'));
      resolve();
    }, 'image/png');
  });
}
