import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import ReportIssue from './ReportIssue';
import { ISSUE_CATEGORY_VALUES } from '../issueReports';

/**
 * `?category=` preselects the dropdown, and an unknown value does not.
 *
 * ── The failure this exists to prevent ──
 *
 * Settings → Accessibility and the Accessibility Statement both link here as
 * `/report-issue?category=accessibility`. The parameter was decorative: this
 * view initialised `category` to `''` and never looked at the URL, so somebody
 * following an "accessibility problem" link landed on a form with an empty
 * dropdown and still had to find the right option — using the interface that was
 * failing them, which is the whole reason they were reporting anything.
 *
 * A link that silently ignores its own parameter is worse than no link, because
 * it looks like a shortcut and behaves like a decoration.
 *
 * ── Why the rejection case matters as much as the acceptance case ──
 *
 * A URL is user input. An unrecognised value must leave the field EMPTY so the
 * existing "Choose what kind of problem this is" validation still fires, rather
 * than preselecting something the server will reject after the person has
 * finished writing.
 */
function renderAt(search) {
  return render(
    <MemoryRouter initialEntries={[`/report-issue${search}`]}>
      <ReportIssue currentUser={{ id: 1, name: 'Alex', role: 'student' }} addToast={() => {}} />
    </MemoryRouter>
  );
}

describe('ReportIssue category preselection', () => {
  it('preselects accessibility, which is what Settings links to', () => {
    renderAt('?category=accessibility');
    expect(screen.getByLabelText(/what kind of problem/i)).toHaveValue('accessibility');
  });

  it('preselects any category the server would accept', () => {
    /* Derived from the shared vocabulary rather than a list typed here, so a
       category added server-side is covered the day it is added. */
    for (const value of ISSUE_CATEGORY_VALUES) {
      const { unmount } = renderAt(`?category=${value}`);
      expect(screen.getByLabelText(/what kind of problem/i), `category=${value}`).toHaveValue(value);
      unmount();
    }
  });

  it('ignores a category the server would reject, leaving validation to fire', () => {
    renderAt('?category=not-a-real-category');
    expect(screen.getByLabelText(/what kind of problem/i)).toHaveValue('');
  });

  it('ignores an absent parameter', () => {
    renderAt('');
    expect(screen.getByLabelText(/what kind of problem/i)).toHaveValue('');
  });
});
