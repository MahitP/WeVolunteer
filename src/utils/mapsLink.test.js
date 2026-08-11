import { describe, it, expect } from 'vitest';
import { detectMapsPlatform, mapsDirectionsUrl, hasMapsDestination } from './mapsLink';

/**
 * The point of this module is that a volunteer who navigates with Waze is not
 * silently handed Google Maps. These tests are mostly about that promise.
 */

const nav = (over) => ({ platform: '', userAgent: '', ...over });

const PINNED = {
  latitude: 40.386,
  longitude: -74.556,
  address: '100 Reichler Park Drive, Example Valley, NJ 08824',
  location: 'Reichler Park',
};

describe('detectMapsPlatform', () => {
  it('reads userAgentData when the browser offers it', () => {
    expect(detectMapsPlatform(nav({ userAgentData: { platform: 'Android' } }))).toBe('android');
    expect(detectMapsPlatform(nav({ userAgentData: { platform: 'macOS' } }))).toBe('apple');
    expect(detectMapsPlatform(nav({ userAgentData: { platform: 'Windows' } }))).toBe('other');
  });

  it('falls back to navigator.platform', () => {
    expect(detectMapsPlatform(nav({ platform: 'iPhone' }))).toBe('apple');
    expect(detectMapsPlatform(nav({ platform: 'MacIntel' }))).toBe('apple');
    expect(detectMapsPlatform(nav({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)' }))).toBe('android');
    expect(detectMapsPlatform(nav({ platform: 'Win32' }))).toBe('other');
  });

  it('treats an Android user agent as Android even when the platform says Linux', () => {
    expect(detectMapsPlatform(nav({
      platform: 'Linux aarch64',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
    }))).toBe('android');
  });

  it('does not mistake an Android device for Apple, despite AppleWebKit in its user agent', () => {
    /* Every Android Chrome UA contains the string "AppleWebKit". A naive
       /apple/i test would send the whole Android fleet to Apple Maps. */
    const platform = detectMapsPlatform(nav({
      platform: '',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
    }));
    expect(platform).toBe('android');
  });

  it('says "other" rather than throwing when there is no navigator at all', () => {
    expect(detectMapsPlatform(null)).toBe('other');
  });
});

describe('mapsDirectionsUrl', () => {
  it('uses a geo: URI on Android, so the system app chooser appears', () => {
    const url = mapsDirectionsUrl(PINNED, 'android');
    expect(url.startsWith('geo:0,0?q=')).toBe(true);
    expect(url).toContain('40.386,-74.556');
    expect(url).toContain(encodeURIComponent('Reichler Park'));
  });

  it('uses Apple Maps on Apple platforms, with a driving route', () => {
    const url = mapsDirectionsUrl(PINNED, 'apple');
    expect(url.startsWith('https://maps.apple.com/?daddr=')).toBe(true);
    expect(url).toContain('dirflg=d');
    expect(url).toContain(encodeURIComponent('40.386,-74.556'));
  });

  it('uses Google Maps directions everywhere else', () => {
    const url = mapsDirectionsUrl(PINNED, 'other');
    expect(url.startsWith('https://www.google.com/maps/dir/?api=1&destination=')).toBe(true);
    expect(url).toContain(encodeURIComponent('40.386,-74.556'));
  });

  it('never sends an Android device to google.com', () => {
    /* The whole reason this module exists. */
    expect(mapsDirectionsUrl(PINNED, 'android')).not.toContain('google.com');
  });

  describe('destination precedence', () => {
    it('prefers coordinates, which cannot resolve to the wrong town', () => {
      const url = mapsDirectionsUrl(PINNED, 'other');
      expect(url).toContain(encodeURIComponent('40.386,-74.556'));
      expect(url).not.toContain(encodeURIComponent('Reichler Park Drive'));
    });

    it('falls back to the address when there is no pin', () => {
      const url = mapsDirectionsUrl({ address: '8 Library Road, Example Valley, NJ', location: 'Public Library' }, 'other');
      expect(url).toContain(encodeURIComponent('8 Library Road, Example Valley, NJ'));
    });

    it('falls back to the place name when that is all there is', () => {
      const url = mapsDirectionsUrl({ location: 'Public Library' }, 'other');
      expect(url).toContain(encodeURIComponent('Public Library'));
    });

    it('returns null when there is nothing to navigate to', () => {
      expect(mapsDirectionsUrl({}, 'other')).toBeNull();
      expect(mapsDirectionsUrl(null, 'other')).toBeNull();
      expect(mapsDirectionsUrl({ latitude: 40.1 }, 'other')).toBeNull();
    });
  });

  it('encodes a destination that would otherwise break the URI', () => {
    const url = mapsDirectionsUrl({ location: "St. Mary's Hall & Annex, #3" }, 'other');
    expect(url).not.toContain('#');
    expect(url).toContain(encodeURIComponent("St. Mary's Hall & Annex, #3"));
  });

  it('encodes the Android label too', () => {
    const url = mapsDirectionsUrl({ latitude: 1, longitude: 2, location: "St. Mary's Hall" }, 'android');
    expect(url).toContain(encodeURIComponent("St. Mary's Hall"));
  });
});

describe('hasMapsDestination', () => {
  it('is true for a pin, an address, or a bare place name', () => {
    expect(hasMapsDestination(PINNED)).toBe(true);
    expect(hasMapsDestination({ address: '8 Library Road' })).toBe(true);
    expect(hasMapsDestination({ location: 'Public Library' })).toBe(true);
  });

  it('is false when an event has no location information at all', () => {
    expect(hasMapsDestination({})).toBe(false);
    expect(hasMapsDestination(null)).toBe(false);
  });
});
