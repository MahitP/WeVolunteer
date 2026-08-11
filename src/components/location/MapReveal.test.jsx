import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MapReveal from './MapReveal';

/* Leaflet in jsdom is heavy and beside the point: what is under test is the
   gate, not the map. */
vi.mock('./MapPreview', () => ({
  default: ({ label }) => <div data-testid="map-preview">{`map of ${label}`}</div>,
}));

const PIN = { latitude: 40.386, longitude: -74.556, label: 'Reichler Park' };

describe('MapReveal', () => {
  it('renders NO map until somebody asks for one', async () => {
    /**
     * This is the privacy assertion, and it is the reason this component
     * exists rather than a bare `<MapPreview>`.
     *
     * Tiles are fetched by the student's browser, straight to the tile
     * provider, which makes that provider the only third party in the app that
     * learns a student's IP address. If this test ever starts failing because
     * someone "simplified" the button away, the fix is the button, not the
     * test.
     */
    render(<MapReveal {...PIN} />);
    expect(screen.queryByTestId('map-preview')).toBeNull();
  });

  it('says which outside provider the tiles come from', async () => {
    render(<MapReveal {...PIN} />);
    /* A consent nobody can read is not one. */
    expect(screen.getByText(/CARTO/)).toBeInTheDocument();
  });

  it('shows the map once the button is pressed', () => {
    render(<MapReveal {...PIN} />);

    fireEvent.click(screen.getByRole('button', { name: /show map/i }));

    expect(screen.getByTestId('map-preview')).toBeInTheDocument();
  });

  it('can be hidden again', () => {
    render(<MapReveal {...PIN} />);

    fireEvent.click(screen.getByRole('button', { name: /show map/i }));
    fireEvent.click(screen.getByRole('button', { name: /hide map/i }));

    expect(screen.queryByTestId('map-preview')).toBeNull();
  });

  it('renders nothing at all for an event with no pin', () => {
    const { container } = render(<MapReveal latitude={null} longitude={null} label="Local Shelter" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the reveal as a real button, not a div with a handler', () => {
    /* A real button is focusable, activates on Enter and Space, and announces
       itself as a button. All three are free here and all three have to be
       rebuilt badly on a div. */
    render(<MapReveal {...PIN} />);
    const button = screen.getByRole('button', { name: /show map/i });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
  });
});
