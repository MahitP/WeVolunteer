import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LegalUpdateNotice, { noticeCopy, sortForDisplay } from './LegalUpdateNotice';

/**
 * The ordinary "we updated a document" banner.
 *
 * Every legal change used to open a modal, including a reworded sentence. These
 * pin the two halves of the correction: that a clarification is now a banner in
 * the shell's notice slot, and that the copy on it does not overstate or
 * understate what happened.
 */

const NOTICE = {
  slug: 'privacy-policy',
  title: 'Privacy Policy',
  version: '1.1.0',
  previousVersion: '1.0',
  effectiveAt: '2026-09-01',
  severity: 'minor',
  channel: 'notice',
  requiresAcceptance: false,
  excerpt: 'We now keep volunteer attendance records for three school years rather than one.',
  changeCount: 1,
  isSample: false,
};

const draw = (notices, onDismiss = vi.fn()) => ({
  onDismiss,
  ...render(
    <MemoryRouter>
      <LegalUpdateNotice notices={notices} onDismiss={onDismiss} />
    </MemoryRouter>
  ),
});

describe('one document, clarified', () => {
  it('names it, in a voice that works for a plural title', () => {
    /**
     * "We have updated the Community Guidelines", never "The Community
     * Guidelines has been updated".
     *
     * Four registered titles are plural, so any template that puts the title in
     * front of the verb has to pick "has" or "have" from a string. Putting the
     * subject first is correct for every title in the registry and for every
     * one anybody adds later.
     */
    expect(noticeCopy([NOTICE]).title).toBe('We have updated the Privacy Policy');
    expect(noticeCopy([{ ...NOTICE, title: 'Community Guidelines' }]).title)
      .toBe('We have updated the Community Guidelines');
  });

  it('says there is nothing to do, without claiming nothing changed', () => {
    const { body } = noticeCopy([NOTICE]);
    expect(body).toMatch(/nothing you need to do/i);
    /* Something did change — the version moved. The banner must not say
       otherwise; it says there is nothing to ACT on. */
    expect(body).not.toMatch(/nothing (has )?changed/i);
    expect(body).toMatch(/1\.1\.0/);
  });

  /** Part of the contract: the canonical route, not a second document page. */
  it('links to the canonical document route', () => {
    draw([NOTICE]);
    const link = screen.getByRole('link', { name: /view document/i });
    expect(link.getAttribute('href')).toBe('/legal/privacy-policy');
  });

  it('is a labelled region rather than a live region', () => {
    /**
     * WCAG 4.1.3 is about status messages — the result of an action. This is
     * standing page content that happens to be conditional, and a polite live
     * region would announce it over the page title on every navigation. A
     * labelled landmark is reachable at will instead.
     */
    const { container } = draw([NOTICE]);
    const region = container.querySelector('[role="region"]');
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-label')).toBeTruthy();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('gives the dismiss control a name that says what it records', () => {
    draw([NOTICE]);
    const dismiss = screen.getByRole('button', { name: /I have seen that the Privacy Policy changed/i });
    expect(dismiss).toBeTruthy();
  });

  it('dismisses when the X is pressed', () => {
    const { onDismiss } = draw([NOTICE]);
    fireEvent.click(screen.getByRole('button', { name: /I have seen/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses when the reader follows the link', () => {
    /* Somebody who clicked through to the document has unambiguously been shown
       it, so leaving the banner up is nagging them about something they just
       did. It records "seen", never "agreed". */
    const { onDismiss } = draw([NOTICE]);
    fireEvent.click(screen.getByRole('link', { name: /view document/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('hands focus to the page content rather than dropping it', () => {
    /**
     * The `X` unmounts itself, and a button that unmounts while focused drops
     * focus to `<body>` — the next Tab restarts from the skip link, and a
     * screen-reader user has lost their place for the sake of dismissing a
     * banner. `Modal` restores focus to whatever opened the dialog; a banner has
     * no opener, so the page content is the equivalent.
     */
    render(
      <MemoryRouter>
        <main id="main-content" tabIndex={-1}>
          <LegalUpdateNotice notices={[NOTICE]} onDismiss={vi.fn()} />
        </main>
      </MemoryRouter>
    );

    const dismiss = screen.getByRole('button', { name: /I have seen/i });
    dismiss.focus();
    expect(document.activeElement).toBe(dismiss);

    fireEvent.click(dismiss);
    expect(document.activeElement.id).toBe('main-content');
  });

  it('does not steal focus from somewhere else', () => {
    /* Safari does not focus a button on click. Scrolling the page and moving
       the caret because somebody dismissed a banner they were not on is worse
       than leaving focus alone. */
    render(
      <MemoryRouter>
        <main id="main-content" tabIndex={-1}>
          <button type="button" data-elsewhere>Elsewhere</button>
          <LegalUpdateNotice notices={[NOTICE]} onDismiss={vi.fn()} />
        </main>
      </MemoryRouter>
    );

    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.click(screen.getByRole('button', { name: /I have seen/i }));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('renders nothing at all when there is nothing to say', () => {
    const { container } = draw([]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('advance notice of a material change', () => {
  const MATERIAL = {
    ...NOTICE,
    slug: 'terms-of-service',
    title: 'Terms of Service',
    version: '2.0.0',
    severity: 'material',
    effectiveAt: '2026-10-04',
  };

  /**
   * §13: "If a change matters, we will tell you in the app at least 30 days
   * before it takes effect." During that window the banner is the notice, and
   * it has to say both things — that this one matters, and when.
   */
  it('gives the date and says an acceptance will be asked for', () => {
    const { title, body } = noticeCopy([MATERIAL]);
    expect(title).toMatch(/Terms of Service/);
    expect(title).toMatch(/2026/);
    expect(body).toMatch(/significant/i);
    expect(body).toMatch(/accept/i);
  });

  it('does not tell somebody nothing is required of them', () => {
    expect(noticeCopy([MATERIAL]).body).not.toMatch(/nothing you need to do/i);
  });

  it('leads with the material change when a clarification is also pending', () => {
    /* A clarification sorting ahead of a major revision with a deadline would
       headline the one nobody has to act on. */
    const ordered = sortForDisplay([NOTICE, MATERIAL]);
    expect(ordered[0].slug).toBe('terms-of-service');
    expect(noticeCopy([NOTICE, MATERIAL]).title).toMatch(/Terms of Service/);
  });

  it('still accounts for the others', () => {
    expect(noticeCopy([NOTICE, MATERIAL]).body).toMatch(/One other document/i);
  });
});

describe('several documents at once', () => {
  const OTHERS = [
    NOTICE,
    { ...NOTICE, slug: 'cookie-and-tracking-notice', title: 'Cookie and Tracking Notice' },
    { ...NOTICE, slug: 'accessibility-statement', title: 'Accessibility Statement' },
  ];

  /**
   * The whole reason the aggregate exists. Three banners is a wall, and a wall
   * gets dismissed unread — which is the habit that makes the notice for the
   * change that DOES matter worthless.
   */
  it('is still one banner', () => {
    const { container } = draw(OTHERS);
    expect(container.querySelectorAll('.app-notice')).toHaveLength(1);
  });

  it('counts them and names one', () => {
    const { title, body } = noticeCopy(OTHERS);
    expect(title).toBe('We have updated 3 of our documents');
    expect(body).toMatch(/Privacy Policy/);
  });

  it('sends the reader to the Legal Center rather than to one of the three', () => {
    draw(OTHERS);
    const link = screen.getByRole('link', { name: /review updates/i });
    expect(link.getAttribute('href')).toBe('/legal');
  });

  it('has one dismissal for the whole group', () => {
    /* Dismissing "3 documents" and having two come back tomorrow would make
       the count meaningless. */
    const { onDismiss } = draw(OTHERS);
    expect(screen.getAllByRole('button', { name: /I have seen/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /I have seen/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('is deterministic — the same set always produces the same banner', () => {
    const forwards = noticeCopy(OTHERS);
    const backwards = noticeCopy([...OTHERS].reverse());
    /* Reversing the list must not change the headline for a set of equal-weight
       clarifications: the server's order is the order, and a banner whose
       headline depended on fetch timing would be a different notice on every
       reload. */
    expect(forwards.title).toBe(backwards.title);
  });
});
