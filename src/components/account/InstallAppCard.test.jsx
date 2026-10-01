import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import InstallAppCard from './InstallAppCard';
import { captureInstallPrompt, resetInstallPromptForTests } from '../../utils/installPrompt';

/**
 * "Add to Home Screen" (P2-05, ruling 9).
 *
 * The owner asked: "Possible to make 'Add to HomeScreen Button'". He ruled for
 * an install button where the browser offers one and short instructions on
 * iPhone and iPad, where Safari has no prompt — and no service worker, so
 * nothing about how pages load or cache changes.
 *
 * The button exists only when the browser has said the app can be installed
 * (`beforeinstallprompt`). A button that appeared anyway would sometimes do
 * nothing, which is worse than no button.
 */

const READ = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 };
const DESKTOP = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', maxTouchPoints: 0 };

const standalone = (on) => {
  window.matchMedia = vi.fn((q) => ({
    matches: on && /display-mode: standalone/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
};

beforeEach(() => {
  resetInstallPromptForTests();
  standalone(false);
});

describe('the install card', () => {
  it('offers Install when the browser says the app can be installed, and hands over to it', async () => {
    captureInstallPrompt(window);
    render(<InstallAppCard nav={DESKTOP} />);
    expect(screen.queryByRole('button', { name: /Install WeVolunteer/ })).toBeNull();

    const prompt = vi.fn(async () => {});
    const event = new Event('beforeinstallprompt');
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    act(() => { window.dispatchEvent(event); });

    fireEvent.click(await screen.findByRole('button', { name: /Install WeVolunteer/ }));
    expect(prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/installed/i)).toBeInTheDocument());
  });

  it('tells an iPhone how, since Safari has no install button', () => {
    render(<InstallAppCard nav={IPHONE} />);
    expect(screen.getByText(/Share/)).toBeInTheDocument();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });

  it('says so when it is already the installed app', () => {
    standalone(true);
    render(<InstallAppCard nav={IPHONE} />);
    expect(screen.getByText(/using the installed app/i)).toBeInTheDocument();
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
  });

  it('renders nothing where there is neither a prompt nor instructions to give', () => {
    const { container } = render(<InstallAppCard nav={DESKTOP} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('what installing needs, and what it does not', () => {
  it('lists 192 and 512 pixel icons, and a maskable one, beside the drawings', () => {
    const manifest = JSON.parse(READ('public/site.webmanifest'));
    const png = manifest.icons.filter(i => i.type === 'image/png');
    expect(png.map(i => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(png.some(i => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      expect(fs.existsSync(path.join(process.cwd(), 'public', icon.src)), icon.src).toBe(true);
    }
  });

  it('gives iOS a home-screen icon of its own, full-bleed', () => {
    expect(READ('index.html')).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/);
    const png = fs.readFileSync(path.join(process.cwd(), 'public/apple-touch-icon.png'));
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
    /* Colour type 2 is RGB with no alpha: iOS fills transparent corners with
       black, so the icon must not have any. */
    expect(png[25]).toBe(2);
  });

  it('registers no service worker anywhere (ruling 9)', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) && /serviceWorker\.register/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });

  it('listens for the browser\'s offer from the very start', () => {
    /* The event fires once, early, and is gone if nobody was listening. */
    expect(READ('src/main.jsx')).toMatch(/captureInstallPrompt\(/);
  });
});
