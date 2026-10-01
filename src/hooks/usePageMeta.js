import { useEffect } from 'react';

/**
 * What a page says to a search engine while it is open (FE-02).
 *
 * `description` replaces the `<meta name="description">` index.html ships with,
 * so a result for /about says what About is rather than the product's tagline.
 * `noindex` adds `<meta name="robots" content="noindex, nofollow">` to a page
 * that carries a person — a certificate's result names a student, an appeal or
 * an invitation names its holder, a club's page lists its events. robots.txt
 * already keeps crawlers out of those; this says it again on the page, because
 * robots.txt is advice and a link from elsewhere can still put a page in an
 * index.
 *
 * Both are restored on unmount, the same contract `useDocumentTitle` keeps, so
 * a signed-out reader moving from /about to /legal never carries the wrong one.
 *
 * @param {{ description?: string, noindex?: boolean }} meta
 */
export function usePageMeta({ description, noindex = false } = {}) {
  useEffect(() => {
    if (!description) return undefined;
    let tag = document.querySelector('meta[name="description"]');
    const created = !tag;
    if (created) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'description');
      document.head.appendChild(tag);
    }
    const previous = tag.getAttribute('content');
    tag.setAttribute('content', description);
    return () => {
      if (created) tag.remove();
      else tag.setAttribute('content', previous ?? '');
    };
  }, [description]);

  useEffect(() => {
    if (!noindex) return undefined;
    const tag = document.createElement('meta');
    tag.setAttribute('name', 'robots');
    tag.setAttribute('content', 'noindex, nofollow');
    document.head.appendChild(tag);
    return () => tag.remove();
  }, [noindex]);
}

export default usePageMeta;
