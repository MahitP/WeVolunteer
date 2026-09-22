/**
 * Turning an event id into an event object.
 *
 * ── Why this is a module rather than three lines in App.jsx ──
 *
 * There are two places that resolve an id, and they used to disagree by
 * accident. `openEventById` decided whether to open the modal; the
 * `selectedEvent` derivation decided what the modal was handed once `?event=`
 * was in the URL. Both consulted the same two caches, and both treated a miss
 * as "this event does not exist":
 *
 *   • `events` — the SessionProvider index, fetched with `{mine: 'true'}` for
 *     anybody without `event.moderate`, so by construction "only events this
 *     user is involved in".
 *   • `seenEvents` — whatever a browse surface rendered this session, and
 *     therefore empty on a cold load.
 *
 * 23 notification kinds emit `link: event:<id>`, and two of them are about an
 * event the recipient is deliberately not part of — `FRIEND_SIGNED_UP` ("There
 * may still be places") and `ORGANIZATION_EVENT_POSTED` ("is open for
 * applications"). Those answered "That event is no longer available" for a
 * live, open event. Every notification email's `${APP_URL}/?event=<id>` went
 * through the second site, where an unresolved id renders nothing at all: no
 * modal, no error, no explanation.
 *
 * ── The order, and why it is this way round ──
 *
 * Caches first. Not only because they are free: the browse projection carries
 * `slots` and `viewerBan`, which the narrow session index omits and the modal
 * needs — see the merge reasoning beside `selectedEvent`. Going to the network
 * first would also re-fetch on every notification click for events the reader
 * already has.
 *
 * The network is the fallback. It is `GET /api/events?id=…`, which is the
 * ordinary browse query narrowed by one predicate — so it applies the same
 * authorization and the same per-card disclosure rules, including blanking
 * arrival instructions for anybody who is not going. Resolving a link is a
 * narrowing of browse, not a bypass of it.
 *
 * And a failure resolves to null rather than rejecting. Both callers are event
 * handlers, where a rejection is an unhandled promise — which this codebase
 * treats as fatal.
 */

/** The event one of the two local caches already holds, or null. */
export function findEventLocally(id, events, seenEvents) {
  if (!id) return null;
  return events?.find(e => e.id === id) || seenEvents?.[id] || null;
}

/**
 * The event for `id`, from the caches if either holds it and from the server
 * otherwise.
 *
 * Returns null when it genuinely cannot be resolved — a deleted event, or a
 * mistyped code — which is what lets the caller keep saying "no longer
 * available" for the case where that is actually true.
 */
export async function resolveEventById(id, { events, seenEvents, fetchById } = {}) {
  const local = findEventLocally(id, events, seenEvents);
  if (local) return local;
  if (!id || typeof fetchById !== 'function') return null;

  try {
    return (await fetchById(id)) || null;
  } catch {
    /* Offline, a 500, a refused request. The caller's job is to say the event
       could not be opened; it is not to crash the shell trying. */
    return null;
  }
}
