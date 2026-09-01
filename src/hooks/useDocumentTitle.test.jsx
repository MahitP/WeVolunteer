import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';
import { APP_NAME } from '../config';

/**
 * The one mechanism for a title that comes from DATA rather than from a route.
 *
 * `App.jsx` titles shell routes from `PAGE_META`, keyed on the path. That is
 * right for pages whose name is a property of the route and useless for
 * `/legal/:slug`, where one route serves thirteen documents and the only thing
 * that tells them apart has not been fetched yet.
 *
 * `ErrorExperience` had written this effect by hand; the Legal Center needed
 * the same thing, so it moved here rather than being copied. These cases pin
 * the behaviour both callers depend on — particularly the restore, which is
 * what stops one page's title following the reader to the next.
 */

function Titled({ title }) {
  useDocumentTitle(title);
  return null;
}

let original;
beforeEach(() => { original = document.title; document.title = 'Dashboard · WeVolunteer'; });
afterEach(() => { cleanup(); document.title = original; });

describe('useDocumentTitle', () => {
  it('names the tab and appends the app name', () => {
    render(<Titled title="Privacy Policy" />);
    expect(document.title).toBe(`Privacy Policy · ${APP_NAME}`);
  });

  it('does not repeat the app name when the title IS the app name', () => {
    render(<Titled title={APP_NAME} />);
    expect(document.title).toBe(APP_NAME);
  });

  it('leaves the tab alone while there is nothing to say', () => {
    /* The loading state of a document page. A placeholder here would make the
       tab flicker through "Loading" on every legal navigation. */
    render(<Titled title={null} />);
    expect(document.title).toBe('Dashboard · WeVolunteer');
  });

  it('restores the previous title on unmount', () => {
    /**
     * The case that matters and the reason this is not a bare assignment.
     * `App.jsx`'s effect only re-runs when the pathname changes, so without the
     * restore a reader who closes a legal document without navigating keeps its
     * name on the tab, and a signed-out reader — who has no `App.jsx` effect at
     * all — keeps it indefinitely.
     */
    const view = render(<Titled title="Youth Safety Guidelines" />);
    expect(document.title).toBe(`Youth Safety Guidelines · ${APP_NAME}`);

    view.unmount();
    expect(document.title).toBe('Dashboard · WeVolunteer');
  });

  it('follows the data when the title changes without a remount', () => {
    /* `/legal/a` → `/legal/b` is one route: React re-renders with new data and
       nothing unmounts. A hook that only ran on mount would leave the first
       document's name on the tab for the second document. */
    const view = render(<Titled title="Terms of Service" />);
    view.rerender(<Titled title="Cookie and Tracking Notice" />);

    expect(document.title).toBe(`Cookie and Tracking Notice · ${APP_NAME}`);
  });

  it('restores the ORIGINAL title, not the one it set itself', () => {
    /* Guards the sequencing of the cleanup against the next effect: if the
       restore captured the value after a previous run had written it, unmounting
       would leave a stale document title behind instead of the route's. */
    const view = render(<Titled title="Terms of Service" />);
    view.rerender(<Titled title="Community Guidelines" />);
    view.unmount();

    expect(document.title).toBe('Dashboard · WeVolunteer');
  });
});
