/**
 * Driving Welly's event-creation conversation from a test.
 *
 * ── Why a fixture rather than a literal in each file ──
 *
 * A valid event needs six answers, and two of them are dates that must be in
 * the future relative to the moment the suite runs — a hard-coded "September
 * 15" passes today and starts failing on its own next year, which is the
 * failure mode that gets a test deleted rather than fixed. So the days are
 * computed from `Date.now()` and the conversation is one call.
 *
 * The point of the helper is that it goes through `ask()` exactly as an
 * organizer would, one message at a time. Nothing here reaches into the
 * collection's internals or short-circuits a question, because the thing worth
 * testing is that the turns actually work.
 */

const pad = n => String(n).padStart(2, '0');

/** `YYYY-MM-DD`, `days` from now, in local time. */
export function inDays(days) {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * A complete, valid event, as the six messages that supply it.
 *
 * `shiftDay` defaults to three weeks out and the deadline to a week before it,
 * so the whole thing satisfies "deadline in the future" and "deadline on or
 * before the first shift" without either being borderline.
 */
export function eventAnswers(over = {}) {
  return {
    title: 'Food Drive',
    location: 'South Brunswick Community Center',
    shiftDay: inDays(21),
    hours: '9 AM to 1 PM',
    spots: 20,
    description: 'Sorting and boxing donated food for the pantry.',
    deadlineDay: inDays(14),
    ...over,
  };
}

/**
 * Walk `ask` through the whole collection and return every reply.
 *
 * Stops early if Welly says something that is not a question — an invalid
 * event, a refusal — so a test asserting on a failure gets the reply that
 * caused it rather than five more answers shouted at a closed conversation.
 */
export async function collectEvent(ask, user, over = {}) {
  const a = eventAnswers(over);
  const turns = [];

  const say = async message => {
    const res = await ask(message, { user });
    turns.push({ message, res });
    return res;
  };

  let res = await say('create an event');
  if (!res.collecting) return { turns, last: res };

  for (const answer of [
    a.title,
    a.location,
    a.shiftDay,
    `${a.hours} with ${a.spots} volunteers`,
    a.description,
    a.deadlineDay,
  ]) {
    res = await say(String(answer));
    if (!res.collecting) break;
  }

  return { turns, last: res, answers: a };
}
