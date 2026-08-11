import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LocationLink from './LocationLink';

/**
 * The affordance that turns an address from text into somewhere you can go.
 *
 * These pin the two things most likely to be broken by a well-meaning edit: that
 * a missing pin still produces a working link, and that an event with no
 * location at all produces no link rather than one that goes nowhere.
 */

const PINNED = {
  location: 'Reichler Park',
  address: '100 Reichler Park Drive, Example Valley, NJ 08824',
  latitude: 40.386,
  longitude: -74.556,
};

describe('LocationLink', () => {
  it('renders the place name as a link', () => {
    render(<LocationLink {...PINNED} />);
    const link = screen.getByRole('link', { name: /Reichler Park/ });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBeTruthy();
  });

  it('navigates to the coordinates when the event has them', () => {
    render(<LocationLink {...PINNED} />);
    expect(screen.getByRole('link').getAttribute('href')).toContain(encodeURIComponent('40.386,-74.556'));
  });

  it('still links when the event has an address but no pin', () => {
    /* The common case: an organizer typed a place name and never opened the
       picker. This used to render plain text, so the majority of events had no
       directions affordance at all. */
    render(<LocationLink location="Public Library" address="8 Library Road, Example Valley, NJ" />);
    const link = screen.getByRole('link', { name: /Public Library/ });
    expect(link.getAttribute('href')).toContain(encodeURIComponent('8 Library Road, Example Valley, NJ'));
  });

  it('still links when all it has is a place name', () => {
    render(<LocationLink location="HS Gym" />);
    expect(screen.getByRole('link', { name: /HS Gym/ }).getAttribute('href')).toContain(encodeURIComponent('HS Gym'));
  });

  it('renders no link at all when the event has no location', () => {
    render(<LocationLink />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Location to be announced/)).toBeInTheDocument();
  });

  it('marks the destination as external and safe to open', () => {
    render(<LocationLink {...PINNED} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('tells a screen reader where the link goes', () => {
    render(<LocationLink {...PINNED} />);
    /* The accessible name carries the destination as well as the place, so
       somebody who cannot see the glyph still knows this leaves the page. */
    expect(screen.getByRole('link', { name: /opens directions/i })).toBeInTheDocument();
  });

  it('does not announce a new tab when the link hands off to a native app', () => {
    /* geo: opens Waze or Google Maps, not a tab. Saying "new tab" would be a
       lie told only to screen-reader users. */
    render(<LocationLink {...PINNED} />);
    const link = screen.getByRole('link');
    if (link.getAttribute('href').startsWith('geo:')) {
      expect(link.textContent).not.toMatch(/new tab/i);
      expect(link.getAttribute('target')).toBeNull();
    } else {
      expect(link.textContent).toMatch(/new tab/i);
    }
  });

  it('prefers the place name over the address as the visible text', () => {
    render(<LocationLink {...PINNED} />);
    /* "Reichler Park" is what a volunteer recognises; the street address is
       detail the caller renders separately when it wants it. */
    expect(screen.getByRole('link').textContent).toContain('Reichler Park');
  });
});
