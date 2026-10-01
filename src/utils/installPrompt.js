/**
 * The browser's "this app can be installed" offer, kept until it is used.
 *
 * Chromium fires `beforeinstallprompt` once, early in the page's life, and
 * only then; a component mounted later — the Settings card that offers
 * installation (P2-05, ruling 9) — would never hear it. So `main.jsx` starts
 * listening before the app renders, the event is held here, and the card asks
 * for it whenever it mounts.
 *
 * `preventDefault()` stops the browser's own mini-infobar, so the offer is made
 * in one place, by the product, when somebody asks for it.
 */
let deferred = null;
let installed = false;
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn());

export function captureInstallPrompt(win = window) {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

/** `{ prompt, installed }` — the held event, or null, and whether it was used. */
export const installState = () => ({ prompt: deferred, installed });

export function subscribeInstall(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Show the browser's own install dialog. Resolves to whether it was accepted. */
export async function promptInstall() {
  const event = deferred;
  if (!event) return false;
  /* The event can be used once; the browser refuses a second `prompt()`. */
  deferred = null;
  await event.prompt();
  const choice = await event.userChoice;
  if (choice?.outcome === 'accepted') installed = true;
  notify();
  return choice?.outcome === 'accepted';
}

/** Tests only: forget anything a previous test captured. */
export function resetInstallPromptForTests() {
  deferred = null;
  installed = false;
  listeners.clear();
}
