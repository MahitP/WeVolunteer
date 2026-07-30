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

export function validateEventPayload({ title, description, location, instructions, applicationDeadline, slots, address, latitude, longitude }) {
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
    // A null or non-object entry would throw on the property reads below,
    // surfacing a client mistake as a 500.
    if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) {
      return { ok: false, error: 'Each shift must be an object.' };
    }

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

    // Text fields must BE strings, not merely be length-checked when they
    // happen to be one: a non-string here reaches the SQLite bind and fails
    // there as a 500 instead of being reported as bad input.
    if (typeof slot.name !== 'string' || slot.name.length > MAX_SLOT_NAME_LENGTH) {
      return { ok: false, error: `Each shift name must be text of ${MAX_SLOT_NAME_LENGTH} characters or fewer.` };
    }
    if (typeof slot.description !== 'string' || slot.description.length > MAX_SLOT_DESCRIPTION_LENGTH) {
      return { ok: false, error: `Each shift description must be text of ${MAX_SLOT_DESCRIPTION_LENGTH} characters or fewer.` };
    }

    if (startMs < earliestStartMs) earliestStartMs = startMs;
  }

  if (deadlineMs > earliestStartMs) {
    return { ok: false, error: 'The application deadline must be on or before the first shift starts.' };
  }

  // As above: these must BE strings. The routes already reject missing values,
  // so a non-string here is a wrong-type payload, not an absent one.
  if (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `Title must be text of ${MAX_TITLE_LENGTH} characters or fewer.` };
  }
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `Description must be text of ${MAX_DESCRIPTION_LENGTH} characters or fewer.` };
  }
  if (typeof location !== 'string' || location.length > MAX_LOCATION_LENGTH) {
    return { ok: false, error: `Location must be text of ${MAX_LOCATION_LENGTH} characters or fewer.` };
  }
  // Instructions are optional: absent/empty is fine, but a supplied value must
  // be text.
  if (instructions !== undefined && instructions !== null && instructions !== '') {
    if (typeof instructions !== 'string' || instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return { ok: false, error: `Instructions must be text of ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.` };
    }
  }

  // Location Picker: optional structured geo fields.
  const MAX_ADDRESS_LENGTH = 500;
  if (address !== undefined && address !== null && address !== '') {
    if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH) {
      return { ok: false, error: `Address must be text of ${MAX_ADDRESS_LENGTH} characters or fewer.` };
    }
  }
  if (latitude !== undefined && latitude !== null) {
    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
      return { ok: false, error: 'Latitude must be a number between -90 and 90.' };
    }
  }
  if (longitude !== undefined && longitude !== null) {
    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
      return { ok: false, error: 'Longitude must be a number between -180 and 180.' };
    }
  }
  // If one coordinate is provided, both must be.
  const hasLat = latitude !== undefined && latitude !== null;
  const hasLng = longitude !== undefined && longitude !== null;
  if (hasLat !== hasLng) {
    return { ok: false, error: 'Both latitude and longitude must be provided together.' };
  }

  return { ok: true };
}
