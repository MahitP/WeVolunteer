/**
 * Server-side validation for event/slot create and update payloads.
 *
 * Pure function: no DB access, no imports from routes or app.js. Every
 * temporal/numeric/length guard the client already enforces is repeated
 * here because the client is not trustworthy — this is the backstop.
 *
 * Deliberately does NOT validate `category` or field presence: the routes
 * already do both and will keep doing so before calling this.
 */

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_LOCATION_LENGTH = 300;
const MAX_INSTRUCTIONS_LENGTH = 5000;
const MAX_SLOT_NAME_LENGTH = 120;
const MAX_SLOT_DESCRIPTION_LENGTH = 1000;
const MIN_MAX_SPOTS = 1;
const MAX_MAX_SPOTS = 100;

export function validateEventPayload({ title, description, location, instructions, applicationDeadline, slots }) {
  const deadlineMs = Date.parse(applicationDeadline);
  if (isNaN(deadlineMs)) {
    return { ok: false, error: 'The application deadline must be a valid date in the future.' };
  }
  if (deadlineMs <= Date.now()) {
    return { ok: false, error: 'The application deadline must be a valid date in the future.' };
  }

  if (!Array.isArray(slots) || slots.length === 0) {
    return { ok: false, error: 'At least one shift is required.' };
  }

  let earliestStartMs = Infinity;
  for (const slot of slots) {
    const startMs = Date.parse(slot.startDatetime);
    const endMs = Date.parse(slot.endDatetime);
    if (isNaN(startMs) || isNaN(endMs)) {
      return { ok: false, error: 'Each shift must have a valid start and end date.' };
    }
    if (endMs <= startMs) {
      return { ok: false, error: 'Each shift must end after it starts.' };
    }

    const maxSpotsNum = Number(slot.maxSpots);
    if (!Number.isInteger(maxSpotsNum) || maxSpotsNum < MIN_MAX_SPOTS || maxSpotsNum > MAX_MAX_SPOTS) {
      return { ok: false, error: `Each shift must allow between ${MIN_MAX_SPOTS} and ${MAX_MAX_SPOTS} volunteers.` };
    }

    if (typeof slot.name === 'string' && slot.name.length > MAX_SLOT_NAME_LENGTH) {
      return { ok: false, error: `Each shift name must be ${MAX_SLOT_NAME_LENGTH} characters or fewer.` };
    }
    if (typeof slot.description === 'string' && slot.description.length > MAX_SLOT_DESCRIPTION_LENGTH) {
      return { ok: false, error: `Each shift description must be ${MAX_SLOT_DESCRIPTION_LENGTH} characters or fewer.` };
    }

    if (startMs < earliestStartMs) earliestStartMs = startMs;
  }

  if (deadlineMs > earliestStartMs) {
    return { ok: false, error: 'The application deadline must be on or before the first shift starts.' };
  }

  if (typeof title === 'string' && title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` };
  }
  if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.` };
  }
  if (typeof location === 'string' && location.length > MAX_LOCATION_LENGTH) {
    return { ok: false, error: `Location must be ${MAX_LOCATION_LENGTH} characters or fewer.` };
  }
  if (instructions && typeof instructions === 'string' && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return { ok: false, error: `Instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.` };
  }

  return { ok: true };
}
