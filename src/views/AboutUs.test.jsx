/**
 * The About Us page.
 *
 * ── Why a page of prose has tests at all ──
 *
 * Not to pin the wording, which will change. Two things here are structural and
 * would break silently: the heading outline a screen-reader user navigates by,
 * and the promise that this page makes no claim the product cannot support.
 *
 * The second is the one worth automating. A page whose whole job is to make
 * WeVolunteer feel trustworthy is the worst possible place for an invented
 * statistic, and "someone will notice in review" is how those arrive.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AboutUs from './AboutUs';

const renderAbout = () => render(<MemoryRouter><AboutUs /></MemoryRouter>);

describe('AboutUs', () => {
  it('has exactly one top-level heading', () => {
    renderAbout();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  /**
   * The outline is how a screen-reader user moves through two thousand words.
   * A section missing its heading is a section they cannot jump to.
   */
  it('gives every section a heading, in order and without skipping a level', () => {
    const { container } = renderAbout();
    const levels = [...container.querySelectorAll('h1, h2, h3')]
      .map(el => Number(el.tagName[1]));

    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('covers the sections the page exists to carry', () => {
    renderAbout();
    for (const heading of [
      /Our mission/i, /Why WeVolunteer exists/i, /Our vision/i, /What we believe/i,
      /For volunteers/i, /For organizers/i, /Community impact/i, /Our commitment/i,
      /Looking ahead/i,
    ]) {
      expect(screen.getByRole('heading', { name: heading }), String(heading)).toBeInTheDocument();
    }
  });

  /**
   * The motto is the last thing SAID, and it is preceded by something that earns
   * it.
   *
   * An earlier draft asserted "because we care" after nineteen hundred words in
   * which the only people shown caring were the volunteers — the reader had been
   * given no evidence about the operator at all. The fix was a concrete,
   * checkable decision immediately above it, so both halves are pinned: the
   * claim's presence, and its position relative to the motto.
   */
  it('ends on the motto', () => {
    const { container } = renderAbout();
    const motto = container.querySelector('.about-motto');
    expect(motto).toHaveTextContent(/because we care\./i);

    const earned = container.querySelector('.about-earned');
    expect(earned).toBeTruthy();
    /* DOCUMENT_POSITION_FOLLOWING: the motto comes after the passage that earns it. */
    expect(earned.compareDocumentPosition(motto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('backs the motto with a decision a reader could go and check', () => {
    renderAbout();
    /* The derived-hours invariant: real behaviour (hoursLedger.js), stated in
       plain words, with the tradeoff named. If this claim is ever removed the
       motto goes back to being unearned. */
    expect(screen.getByText(/never stored as a total/i)).toBeInTheDocument();
  });

  /**
   * Parents and teachers were addressed zero times in the first draft, despite
   * being named in the audience the page is written for. Most adults who reach
   * this page arrive because a student sent them the link.
   */
  it('answers the questions a parent or teacher arrives with', () => {
    renderAbout();
    expect(screen.getByRole('heading', { name: /For parents and teachers/i })).toBeInTheDocument();
    expect(screen.getByText(/private unless they change it/i)).toBeInTheDocument();
    expect(screen.getByText(/confirmed by the organizer/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' }))
      .toHaveAttribute('href', '/legal/privacy-policy');
  });

  it('points the reader at the Legal Center', () => {
    renderAbout();
    expect(screen.getByRole('link', { name: 'Legal Center' })).toHaveAttribute('href', '/legal');
  });

  /**
   * The honesty guard.
   *
   * Nothing in this repository establishes a partnership, a charitable status,
   * a certification, an award, or a number of users — so the page may not imply
   * one. Written as a scan of the rendered text rather than a review checklist,
   * because a checklist is exactly what gets skipped when the copy is edited in
   * a hurry.
   */
  describe('makes no claim the product cannot support', () => {
    const text = () => renderAbout().container.textContent;

    it('claims no legal or charitable status', () => {
      expect(text()).not.toMatch(/\b(501\(c\)|nonprofit|non-profit|charity|registered charity|NGO)\b/i);
    });

    it('claims no endorsement, certification or award', () => {
      expect(text()).not.toMatch(/\b(certified|accredited|award-winning|endorsed by|official partner|in partnership with)\b/i);
    });

    /* No invented scale: "10,000 volunteers", "500+ events", "trusted by 40 schools". */
    it('quotes no figures about its own reach', () => {
      expect(text()).not.toMatch(/\b\d[\d,]*\+?\s*(users|volunteers|students|schools|hours logged|events|organizations|partners)\b/i);
      expect(text()).not.toMatch(/\b(thousands|millions|hundreds) of\b/i);
    });

    it('avoids the language it was written to avoid', () => {
      expect(text()).not.toMatch(/\b(revolutioniz|disrupt(ing|ive)?|game-chang|world-class|best-in-class|synerg|cutting-edge|leverage)/i);
    });
  });
});
