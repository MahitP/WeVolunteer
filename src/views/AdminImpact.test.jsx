/**
 * Platform Impact — the states the data actually arrives in.
 *
 * A dashboard's bugs are almost never in the happy path; they are in the shapes
 * nobody had on screen while building it. Every case below is a shape the
 * server really returns:
 *
 *   - a brand-new platform with no credited hours at all (`growth: []`)
 *   - a platform one month old, where a line chart has two points to join and
 *     no line to draw
 *   - a bucket suppressed under MIN_BUCKET, which carries `count: null`
 *   - `averageHours` / `medianHours` / `returningRate` as `null`, which
 *     `volunteers()` returns rather than zero when there is nobody to average
 *     over — because zero is a claim ("nobody came back") and an empty
 *     programme has not made it
 *
 * The last one is the one that bites: `null` is falsy, so a naive render prints
 * "0%" and the platform tells its owner nobody returned when in fact nobody has
 * volunteered yet.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdminImpact from './AdminImpact';
import { api } from '../utils/api';

vi.mock('../utils/api');

const PAYLOAD = (over = {}) => ({
  generatedAt: '2026-08-08T02:00:00.000Z',
  minBucket: 5,
  community: {
    totalVolunteers: 42, totalHours: 318.5, eventsCompleted: 12, organizationsSupported: 7,
  },
  growth: [
    { month: '2026-05', label: '2026-05', count: 8, suppressed: false, events: 3, hours: 40 },
    { month: '2026-06', label: '2026-06', count: 14, suppressed: false, events: 5, hours: 120 },
    { month: '2026-07', label: '2026-07', count: null, suppressed: true, events: 1, hours: 18 },
  ],
  volunteers: { averageHours: 7.6, medianHours: 5, returningRate: 38, cohort: 42 },
  categories: [
    { label: 'Food Pantry', count: 20, suppressed: false, events: 6, hours: 180 },
    { label: '5K', count: null, suppressed: true, events: 2, hours: 60 },
  ],
  geography: { distinctLocations: 9, breakdown: [] },
  tags: {
    overlapping: true,
    breakdown: [
      { tag: 'environment', label: 'Environment', count: 12, suppressed: false, events: 4, hours: 90 },
      { tag: 'mrsalvarez', label: 'MrsAlvarez', count: null, suppressed: true, events: 1, hours: 12 },
    ],
  },
  definitions: {
    totalVolunteers: 'People marked present at least once.',
    totalHours: 'Hours credited after confirmation.',
    eventsCompleted: 'Events with somebody present.',
    organizationsSupported: 'Organizations that hosted one.',
    returningRate: 'Came back for a second, different event.',
    averageHours: 'Total hours over volunteers.',
    medianHours: 'The middle volunteer.',
    /* Deliberately not a restatement of the label. A fixture whose definition
       text repeats its own label makes every query ambiguous and hides which of
       the two an assertion actually matched. */
    distinctLocations: 'Locations of at least one attended event.',
  },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

const renderPage = () => render(<AdminImpact addToast={() => {}} />);

describe('Platform Impact', () => {
  it('says the figures could not be loaded rather than showing zeros', async () => {
    api.fetchAdminImpact.mockRejectedValue(new Error('nope'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be loaded/i);
    /* The distinction that matters: a failed fetch must never be drawn as a
       real figure. An owner who reads "0 volunteers" during an outage has been
       told something false about their programme. */
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders the headline totals with their definitions', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    renderPage();

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('319')).toBeInTheDocument();
    expect(screen.getByText(/Hours credited after confirmation/)).toBeInTheDocument();
  });

  /**
   * The empty programme. Every chart has to say "nothing yet" rather than
   * divide by a maximum of zero or draw an axis with no points on it.
   */
  it('survives a platform with no credited hours at all', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({
      community: { totalVolunteers: 0, totalHours: 0, eventsCompleted: 0, organizationsSupported: 0 },
      growth: [],
      categories: [],
      volunteers: { averageHours: null, medianHours: null, returningRate: null, cohort: 0 },
      geography: { distinctLocations: 0, breakdown: [] },
    }));
    renderPage();

    expect(await screen.findByText(/No confirmed hours yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No categorised hours yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * `null` is not zero, and the difference is a false claim.
   *
   * `volunteers()` returns null for all three when the cohort is empty. Drawing
   * "0%" for `returningRate` tells the owner nobody came back; the truth is
   * that nobody has volunteered.
   */
  it('omits a participation figure the server declined to compute', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({
      volunteers: { averageHours: null, medianHours: null, returningRate: null, cohort: 0 },
    }));
    renderPage();

    const section = (await screen.findByRole('heading', { level: 2, name: /How people took part/i }))
      .closest('section');

    /* Scoped to the section. The methodology paragraph further down quotes the
       phrase "Came back for more" while EXPLAINING what it counts, so an
       unscoped query matches prose that is supposed to be there. */
    expect(within(section).queryByText(/Came back for more/i)).not.toBeInTheDocument();
    expect(within(section).queryByText('0%')).not.toBeInTheDocument();
    /* Places served has no null case, so the section is present and populated —
       proving the absence above is a filtered figure and not a missing section. */
    expect(within(section).getByText(/Places served/i)).toBeInTheDocument();
  });

  /**
   * A single month. `x(i)` divides by `points.length - 1`, which is zero here —
   * the classic off-by-one that renders every point at `NaN` and produces an
   * SVG path the browser silently drops.
   */
  it('draws a single month without dividing by zero', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({
      growth: [{ month: '2026-06', label: '2026-06', count: 9, suppressed: false, events: 2, hours: 55 }],
    }));
    const { container } = renderPage();

    await screen.findByText(/Hours credited, by month/i);
    const dot = container.querySelector('.chart-dot');
    expect(dot).not.toBeNull();
    for (const attr of ['cx', 'cy']) {
      expect(Number(dot.getAttribute(attr)), `${attr} is NaN`).not.toBeNaN();
    }
  });

  /** A flat series makes `max` the same as every value; nothing may divide by zero. */
  it('draws a series where every month is identical', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({
      growth: [0, 1, 2].map(i => ({
        month: `2026-0${i + 4}`, label: '', count: 6, suppressed: false, events: 1, hours: 30,
      })),
    }));
    const { container } = renderPage();

    await screen.findByText(/Hours credited, by month/i);
    for (const dot of container.querySelectorAll('.chart-dot')) {
      expect(Number(dot.getAttribute('cy'))).not.toBeNaN();
    }
  });

  it('handles a very large total without breaking the axis', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({
      community: {
        totalVolunteers: 1250000, totalHours: 9876543, eventsCompleted: 40000, organizationsSupported: 900,
      },
    }));
    renderPage();

    /* Grouped, not raw digits — `9876543` unseparated is unreadable at a
       glance, which is the entire job of a headline figure. */
    expect(await screen.findByText('9,876,543')).toBeInTheDocument();
  });

  /**
   * Suppression is announced, not hidden.
   *
   * A reader who sees three months and two volunteer counts has to be told the
   * third was withheld; otherwise the gap reads as "nobody came", which is a
   * quieter kind of lie than the number would have been.
   */
  it('says when a bucket was withheld rather than leaving a silent gap', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    renderPage();

    expect(await screen.findByText(/One month has a\s+volunteer count withheld/i)).toBeInTheDocument();
    expect(screen.getByText(/One category is shown\s+by hours only/i)).toBeInTheDocument();
  });

  /* ── Accessibility ───────────────────────────────────────────────────── */

  /**
   * A chart that is only a picture is unreadable to a screen reader and to
   * anybody who wants the exact number. Both affordances are required: a
   * summary on the graphic itself, and the values as a real table.
   */
  it('gives the trend chart a spoken summary and a table of its values', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    renderPage();

    const chart = await screen.findByRole('img', { name: /hours credited by month/i });
    expect(chart).toHaveAccessibleName(/318|hours in total/i);

    const table = screen.getByRole('table');
    expect(within(table).getByText(/May 2026/)).toBeInTheDocument();
    /* The suppressed month appears in the table as "withheld" rather than as a
       number or a blank cell. */
    expect(within(table).getByText(/withheld/i)).toBeInTheDocument();
  });

  it('labels every section with a heading the page structure exposes', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    renderPage();

    await screen.findByText(/Hours credited, by month/i);
    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    expect(headings).toEqual(expect.arrayContaining([
      'Totals', 'Hours credited, by month', 'Where the effort went',
      'How people took part', 'How these are counted',
    ]));
  });

  it('marks the region busy while the figures are still loading', async () => {
    let resolve;
    api.fetchAdminImpact.mockReturnValue(new Promise(r => { resolve = r; }));
    const { container } = renderPage();

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    resolve(PAYLOAD());
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
  });

  /**
   * The bar chart's minimum width is a floor on the DRAWING only.
   *
   * A tiny-but-real value must still be a visible mark, and the number beside
   * it must still be exact — a bar drawn at 1.5% next to a label saying its true
   * value is honest; a bar rounded up to 1.5% AND a value rounded to match it
   * would not be.
   */
  it('keeps a tiny bar visible without overstating its value', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({
      categories: [
        { label: 'Food Pantry', count: 20, suppressed: false, events: 6, hours: 5000 },
        { label: 'Other', count: 6, suppressed: false, events: 1, hours: 3 },
      ],
    }));
    const { container } = renderPage();

    /* Scoped to the category section. There are now TWO bar charts on this page —
       categories and tags — so a document-wide `.chart-bar-fill` query picks up
       both and the indices mean nothing. */
    const section = (await screen.findByRole('heading', { level: 2, name: /Where the effort went/i }))
      .closest('section');
    const fills = section.querySelectorAll('.chart-bar-fill');
    expect(fills).toHaveLength(2);
    expect(parseFloat(fills[1].style.width)).toBeGreaterThan(0);
    /* Read off the bar's own value cell. `getByText('3')` matches an axis label
       too, and a test that passes on the wrong "3" proves nothing. */
    const rows = section.querySelectorAll('.chart-bar-row');
    expect(rows[1].querySelector('.chart-bar-value').textContent).toMatch(/^3\s*h$/);
  });


  /* ── The snapshot export ─────────────────────────────────────────────── */

  /**
   * The export has to be the CURRENT theme, and that was the whole reason the
   * `html2canvas` dependency was replaced: rasterising the page made theme
   * fidelity a hope. `snapshotSvg` reads the resolved token values out of the
   * live document, so the assertion worth making is that the colours in the file
   * are the ones the document is actually using — not that a PNG appeared.
   */
  it('writes the current theme\'s resolved colours into the exported SVG', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());

    /* A dark surface, set the way the theme toggle sets it. If the export read a
       hardcoded palette instead of the document, this value could not appear. */
    document.documentElement.style.setProperty('--surface', 'rgb(11, 12, 14)');
    document.documentElement.style.setProperty('--brand', 'rgb(52, 211, 153)');

    let captured = '';
    const createObjectURL = vi.fn((blob) => { captured = blob; return 'blob:snapshot'; });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    renderPage();
    const button = await screen.findByRole('button', { name: /download snapshot/i });
    button.click();

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const svg = await captured.text();

    expect(svg).toContain('rgb(11, 12, 14)');
    expect(svg).toContain('rgb(52, 211, 153)');
    /* Self-contained: no fetchable external reference. The `xmlns` declaration
       is stripped before the check — it is a namespace identifier that is never
       retrieved, not a resource, and matching on it made this assertion fail on
       a correct file. */
    const withoutNamespace = svg.replace(/xmlns="[^"]*"/g, '');
    expect(withoutNamespace).not.toMatch(/<image|xlink:href|https?:\/\//);
    /* The figures, from the same object the page rendered. */
    expect(svg).toContain('42');
    expect(svg).toContain('319');

    document.documentElement.style.removeProperty('--surface');
    document.documentElement.style.removeProperty('--brand');
  });

  /**
   * The object URL is revoked whichever way the export ends.
   *
   * jsdom has no canvas, so `toDataURL` throws here — which is exactly the
   * fallback path, and the leak it must not take: on a dashboard somebody leaves
   * open all afternoon, one retained blob per press adds up.
   */
  it('revokes the object URL even when rasterising fails', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:snapshot', revokeObjectURL });

    renderPage();
    (await screen.findByRole('button', { name: /download snapshot/i })).click();

    /* jsdom has no canvas and will not load a blob: URL into an Image, so
       NEITHER `onload` nor `onerror` fires here — which is exactly the state the
       deadline in `downloadSnapshot` exists for. Without it this promise never
       settles, the `finally` never runs, and every press leaks one object URL
       while the button appears to do nothing. This case is that guard: it is
       what caught the missing timeout. The 5s deadline is why the timeout below
       is generous. */
    await waitFor(
      () => expect(revokeObjectURL).toHaveBeenCalledWith('blob:snapshot'),
      { timeout: 8000 }
    );
  }, 12000);

  /* ── The tag breakdown ─────────────────────────────────────────────────── */

  /**
   * The overlap warning comes BEFORE the bars.
   *
   * An event's hours count under every tag it carries, so this column sums to more
   * than the platform total. A reader who adds it up and only then finds the
   * caveat has already been misled.
   */
  it('warns that tag hours overlap, above the chart', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    renderPage();

    const heading = await screen.findByRole('heading', { level: 2, name: /What organizers tagged/i });
    const section = heading.closest('section');
    expect(within(section).getByText(/these hours overlap/i)).toBeInTheDocument();

    /* Ordering, asserted through the DOM rather than by reading the source. */
    const warning = within(section).getByText(/these hours overlap/i);
    const bars = section.querySelector('.chart-bars');
    expect(warning.compareDocumentPosition(bars) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says how many tags had their volunteer count withheld, and why', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD());
    renderPage();

    await screen.findByRole('heading', { level: 2, name: /What organizers tagged/i });
    expect(screen.getByText(/One tag is shown by\s+hours only/i)).toBeInTheDocument();
    /* Names the reason a tag is more identifying than a category — the privacy
       hazard recorded in Q-2 before tags were built. */
    expect(screen.getByText(/more specific than a category/i)).toBeInTheDocument();
  });

  /**
   * A district that has not started tagging sees no section at all, rather than an
   * empty one implying it is missing something.
   */
  it('omits the tag section entirely when nothing is tagged', async () => {
    api.fetchAdminImpact.mockResolvedValue(PAYLOAD({ tags: { overlapping: true, breakdown: [] } }));
    renderPage();

    await screen.findByRole('heading', { level: 2, name: /Where the effort went/i });
    expect(screen.queryByRole('heading', { name: /What organizers tagged/i })).not.toBeInTheDocument();
  });

  /** And it survives a payload from a server that predates the section. */
  it('does not break when the payload carries no tags section', async () => {
    const { tags, ...withoutTags } = PAYLOAD();
    api.fetchAdminImpact.mockResolvedValue(withoutTags);
    renderPage();

    await screen.findByRole('heading', { level: 2, name: /Where the effort went/i });
    expect(screen.queryByRole('heading', { name: /What organizers tagged/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers the snapshot only once there are figures to snapshot', async () => {
    let resolve;
    api.fetchAdminImpact.mockReturnValue(new Promise(r => { resolve = r; }));
    renderPage();

    expect(screen.queryByRole('button', { name: /download snapshot/i })).not.toBeInTheDocument();
    resolve(PAYLOAD());
    expect(await screen.findByRole('button', { name: /download snapshot/i })).toBeInTheDocument();
  });
});
