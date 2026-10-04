/**
 * Canonical factual knowledge base for WeVolunteer platform questions.
 *
 * ── Why this is a centralized module ──
 *
 * A 1.5B model asked how Auto Select or certificates work will either produce
 * generic vague statements or hallucinate policies. This module provides
 * authoritative, verified descriptions of real WeVolunteer features, data models,
 * and workflows.
 *
 * Informational requests are open to any signed-in user or visitor.
 * Asking "How do organizers create events?" is a request for knowledge, NOT an
 * attempt to create an event, and should always be answered truthfully and clearly.
 */

export const INFORMATIONAL_KNOWLEDGE = Object.freeze({
  info_how_events_work:
    'Events in WeVolunteer are created by organizers (such as teachers, club leaders, or non-profit coordinators). '
    + 'Each event has a title, category, description, location, application deadline, and one or more time slots with set volunteer capacities. '
    + 'Volunteers browse open opportunities, select a shift, and apply. Once accepted, volunteers attend the shift, check in, and receive verified service hours upon completion.',

  info_how_applications_work:
    'When you apply to an event shift, your application is submitted with a status of "pending". '
    + 'The event organizer reviews applicants and can accept, waitlist, or reject applications (or the event may have Auto-Approve or Auto-Select enabled). '
    + 'If accepted, your spot is confirmed. If waitlisted, you are placed in queue order and automatically promoted if an accepted volunteer withdraws. '
    + 'You can withdraw your own application at any time before the shift begins.',

  info_role_capabilities:
    'WeVolunteer has distinct roles:\n'
    + '• Students / Volunteers: Browse opportunities, apply for shifts, track verified hours, earn badges and certificates, log external service, and join clubs.\n'
    + '• Organizers: Create and manage events, review applicants, run Auto-Select lotteries, take attendance, scan QR check-in codes, and award service hours.\n'
    + '• Administrators: people the operator of WeVolunteer has given an administrator account. They oversee platform safety, approve organizers, moderate events and reports, resolve appeals, and view impact analytics.\n'
    + '• Super Admins: Manage platform configuration, view immutable audit logs, and edit legal policies.',

  info_selection:
    'Auto Select (and the Equalizer lottery algorithm) provides fair, transparent selection for high-demand volunteer events with more applicants than available spots. '
    + 'When enabled, the lottery runs after the application deadline, giving priority weighting to volunteers who have had fewer opportunities while ensuring everyone has a fair chance. '
    + 'Applicants not selected are placed on the waitlist in drawn order.',

  info_hours:
    'Volunteer service hours in WeVolunteer come in two forms:\n'
    + '1. Verified Platform Hours: Awarded by organizers when you attend confirmed event shifts and check in. These generate verifiable certificates with unique verification codes.\n'
    + '2. External Service Hours: Self-reported volunteer work completed outside WeVolunteer organizations, logged in your personal portfolio.',

  info_certificates:
    'When an organizer finalizes attendance for a completed event, WeVolunteer automatically generates an official Certificate of Service for each attendee. '
    + 'Each certificate includes a tamper-proof verification code in the format WEV-XXXX-XXXX. '
    + 'Anyone (including school registrars, scholarship committees, and college admissions) can verify a certificate\'s authenticity directly on WeVolunteer.',

  info_organizations:
    'Organizations on WeVolunteer represent school clubs, student organizations, sports teams, and local community groups. '
    + 'Members can join clubs to receive announcements and member-only event opportunities. '
    + 'Student Organizers and Managers can post club updates, create club-associated events, and manage their club roster.',
});

/**
 * Retrieve the canonical informational text for an intent.
 */
export function getInformationalAnswer(intent) {
  return INFORMATIONAL_KNOWLEDGE[intent] || null;
}
