import { useEffect } from 'react';
import { APP_NAME } from '../config';

/**
 * Names the browser tab for a page whose title is not in `PAGE_META`.
 *
 * ── Why this exists as a hook rather than as another effect ──
 *
 * `App.jsx` titles every shell route from `PAGE_META`, keyed by
 * `tabForPath(location.pathname)`. That covers pages whose title is a property
 * of the ROUTE. It cannot cover a page whose title is a property of the DATA —
 * the Legal Center's documents are the case in point: `/legal/privacy-policy`
 * and `/legal/youth-safety-guidelines` are one route, and the only thing that
 * distinguishes their tabs is a document that has not been fetched yet when the
 * route resolves.
 *
 * `ErrorExperience` had already written that effect by hand. A second hand-
 * written copy in the Legal Center would be the start of a parallel
 * title-management system, and the two would drift on the details that matter —
 * whether the app name is appended, whether the previous title is restored.
 * So the effect moved here and both call it. There is still exactly one
 * mechanism for route titles (`PAGE_META`) and now exactly one for data titles,
 * rather than one and two ad-hoc copies.
 *
 * ── Why the previous title is restored on unmount ──
 *
 * `App.jsx`'s effect depends on `location.pathname`, so it re-runs on
 * navigation and would correct the tab anyway on any route change. It does NOT
 * re-run when the pathname is unchanged, which is exactly the Legal Center's
 * shape: `/legal/:slug` → `/legal/:slug` for a different slug unmounts nothing
 * and re-renders with new data, while a signed-out reader has no `App.jsx`
 * effect at all. Restoring is what keeps this correct in both, and it is what
 * `ErrorExperience` already relied on.
 *
 * @param {string|null|undefined} title the page's own name, WITHOUT the app
 *   name. Falsy means "this page has nothing better to say than the route
 *   already does", and the tab is left exactly as it was — which is the state a
 *   document page is in while its document is still loading.
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return undefined;

    const previous = document.title;
    document.title = title === APP_NAME ? APP_NAME : `${title} · ${APP_NAME}`;

    return () => { document.title = previous; };
  }, [title]);
}

export default useDocumentTitle;
