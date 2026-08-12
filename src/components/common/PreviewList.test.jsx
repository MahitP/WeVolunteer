import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PreviewList from './PreviewList';

/**
 * The cap, and the part of capping that gets forgotten: saying that you did it.
 *
 * A list that silently stops at five reads as a complete list of five. A
 * volunteer with two hundred confirmed hours will believe their record is
 * wrong, and the person most affected is the one this product exists to
 * celebrate.
 */

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));

const renderList = (count, cap = 5) => render(
  <MemoryRouter>
    <PreviewList
      items={items(count)}
      cap={cap}
      label="completed shifts"
      moreHref="/hours"
      renderItem={(item) => <div key={item.id}>{item.label}</div>}
    />
  </MemoryRouter>,
);

describe('PreviewList', () => {
  describe('fewer items than the cap', () => {
    it('renders them all', () => {
      renderList(3);
      expect(screen.getByText('Item 0')).toBeInTheDocument();
      expect(screen.getByText('Item 2')).toBeInTheDocument();
    });

    it('offers no link, because there is nothing behind it', () => {
      renderList(3);
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('exactly the cap', () => {
    it('renders them all', () => {
      renderList(5);
      expect(screen.getAllByText(/^Item /)).toHaveLength(5);
    });

    it('still offers no link', () => {
      /* The boundary that produces an off-by-one "Show all 5" pointing at a
         list identical to the one already on screen. */
      renderList(5);
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('more items than the cap', () => {
    it('renders only the cap', () => {
      renderList(47);
      expect(screen.getAllByText(/^Item /)).toHaveLength(5);
    });

    it('shows the newest, not an arbitrary slice', () => {
      renderList(47);
      expect(screen.getByText('Item 0')).toBeInTheDocument();
      expect(screen.queryByText('Item 46')).toBeNull();
    });

    it('says how many there are in total', () => {
      renderList(47);
      expect(screen.getByRole('link', { name: /47/ })).toBeInTheDocument();
    });

    it('tells a screen reader that the list was shortened', () => {
      /* Without this, somebody who cannot see the list ending mid-history has
         no way to learn that it did. */
      renderList(47);
      expect(screen.getByText(/Showing 5 of 47 completed shifts/)).toBeInTheDocument();
    });

    it('navigates to the full record rather than expanding in place', () => {
      /* An inline expansion solves the visual problem by recreating it one
         click later. The full history has a page built for the job. */
      renderList(47);
      expect(screen.getByRole('link').getAttribute('href')).toBe('/hours');
    });

    it('offers a real link, so it can be opened in a new tab', () => {
      renderList(47);
      expect(screen.getByRole('link').tagName).toBe('A');
    });
  });

  it('renders nothing for an empty list', () => {
    renderList(0);
    expect(screen.queryByText(/^Item /)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('uses a caller\'s label for the link when given one', () => {
    render(
      <MemoryRouter>
        <PreviewList
          items={items(9)}
          cap={2}
          label="badges"
          moreHref="/profile"
          moreLabel="See every badge"
          renderItem={(item) => <div key={item.id}>{item.label}</div>}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /See every badge/ })).toBeInTheDocument();
  });
});
