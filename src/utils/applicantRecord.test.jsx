import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { recordKeptPrivate, averageKnownHours } from './applicantRecord';
import ServiceHoursPill from '../components/organizer/ServiceHoursPill';
import VolunteerRosterRow from '../components/organizer/VolunteerRosterRow';
import { rosterOf, rosterCsv } from './volunteerRoster';

/**
 * Applicant rows a student running an event may read without the figures.
 *
 * When the volunteer keeps their record private, the server omits their hours
 * and counts and sends `serviceVisibility: { hours: 'private' }` instead
 * (server/applicantDisclosure.js). Every staff surface that formats those
 * figures would otherwise turn the absence into "0 hrs" — a false statement
 * about a real person.
 */
const visible = (name, volunteeredHours, userId = name) => ({
  userId, status: 'accepted',
  volunteer: { id: userId, name, volunteeredHours, serviceVisibility: { hours: 'visible' } },
});
const kept = (name, userId = name) => ({
  userId, status: 'accepted',
  volunteer: { id: userId, name, serviceVisibility: { hours: 'private' } },
});

describe('recordKeptPrivate', () => {
  it('is true only when the server says the hours are private', () => {
    expect(recordKeptPrivate(kept('A').volunteer)).toBe(true);
    expect(recordKeptPrivate(visible('B', 3).volunteer)).toBe(false);
    /* An older payload, or an adult organizer's, carries no marker at all. */
    expect(recordKeptPrivate({ name: 'C', volunteeredHours: 0 })).toBe(false);
    expect(recordKeptPrivate(undefined)).toBe(false);
  });
});

describe('averageKnownHours', () => {
  it('averages only the hours it can see, and says how many it left out', () => {
    expect(averageKnownHours([visible('A', 10), visible('B', 2), kept('C')]))
      .toEqual({ average: '6.0', keptPrivate: 1 });
  });

  it('does not invent a figure when every record is private', () => {
    expect(averageKnownHours([kept('A'), kept('B')])).toEqual({ average: '0', keptPrivate: 2 });
  });
});

describe('ServiceHoursPill', () => {
  it('says "Private" for a private record, never "0 hrs"', () => {
    const { container } = render(<ServiceHoursPill volunteer={kept('A').volunteer} />);
    expect(screen.getByText(/Private/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/hrs/);
  });

  it('formats the hours when they are visible', () => {
    render(<ServiceHoursPill volunteer={visible('A', 2).volunteer} />);
    expect(screen.getByText('2 hrs')).toBeInTheDocument();
  });
});

describe('the volunteer roster', () => {
  it('lists a private record after every known one, without a figure', () => {
    const roster = rosterOf([kept('Pat'), visible('Val', 40), visible('Nia', 2)]);
    expect(roster.map(r => r.name)).toEqual(['Val', 'Nia', 'Pat']);
    expect(roster.find(r => r.name === 'Pat').hours).toBeNull();
  });

  it('draws a private record as private, not as zero', () => {
    const [person] = rosterOf([kept('Pat')]);
    const { container } = render(<VolunteerRosterRow person={person} onViewProfile={() => {}} />);
    expect(container.querySelector('.hourspill').textContent).toMatch(/Private/);
    expect(container.textContent).not.toMatch(/0 hrs/);
  });

  it('writes "Private" in the ledger, not 0.00', () => {
    const line = rosterCsv([kept('Pat'), visible('Val', 4)]).split('\n').find(l => l.includes('Pat'));
    expect(line).toMatch(/"Private"$/);
    expect(line).not.toMatch(/0\.00/);
  });
});
