import { describe, it, expect } from 'vitest';
import { ask } from './assistant.js';
import { checkRole } from './roles.js';
import { routeIntent } from './router.js';
import { INFORMATIONAL_KNOWLEDGE, getInformationalAnswer } from './informational.js';

const student = { id: 's1', role: 'student' };
const organizer = { id: 'o1', role: 'organizer' };
const admin = { id: 'a1', role: 'admin' };

describe('informational knowledge base and questions', () => {
  it('has factual content for all declared informational intents', () => {
    const keys = [
      'info_how_events_work',
      'info_how_applications_work',
      'info_role_capabilities',
      'info_selection',
      'info_hours',
      'info_certificates',
      'info_organizations',
    ];
    for (const key of keys) {
      const answer = getInformationalAnswer(key);
      expect(answer, `Knowledge for ${key} must exist and be non-empty`).toBeTruthy();
      expect(typeof answer).toBe('string');
      expect(answer.length).toBeGreaterThan(30);
    }
  });

  it('allows every role including students to ask all informational intents', () => {
    const intents = Object.keys(INFORMATIONAL_KNOWLEDGE);
    for (const role of [student, organizer, admin, null]) {
      for (const intent of intents) {
        const verdict = checkRole(role, intent);
        expect(verdict.allowed, `${role?.role || 'visitor'} must be allowed to ask ${intent}`).toBe(true);
        expect(verdict.capability).toBeNull();
      }
    }
  });

  it('routes natural language questions to informational intents', () => {
    expect(routeIntent('How do organizers create events?').intent).toBe('info_how_events_work');
    expect(routeIntent('How does event creation work?').intent).toBe('info_how_events_work');
    expect(routeIntent('How do events work?').intent).toBe('info_how_events_work');

    expect(routeIntent('How does Auto Select work?').intent).toBe('info_selection');
    expect(routeIntent('What is equalizer?').intent).toBe('info_selection');
    expect(routeIntent("Why wasn't I selected for that shift?").intent).toBe('info_selection');

    expect(routeIntent('What can organizers do?').intent).toBe('info_role_capabilities');
    expect(routeIntent('What can admins do?').intent).toBe('info_role_capabilities');
    expect(routeIntent('What does an admin do?').intent).toBe('info_role_capabilities');

    expect(routeIntent('How do applications work?').intent).toBe('info_how_applications_work');
    expect(routeIntent('What happens after I apply?').intent).toBe('info_how_applications_work');

    expect(routeIntent('How do volunteer hours work?').intent).toBe('info_hours');
    expect(routeIntent('How are hours verified?').intent).toBe('info_hours');

    expect(routeIntent('How do certificates work?').intent).toBe('info_certificates');
    expect(routeIntent('What is a certificate code?').intent).toBe('info_certificates');

    expect(routeIntent('How do clubs work?').intent).toBe('info_organizations');
  });

  it('answers students asking about organizer/admin workflows without permission refusals', async () => {
    const res1 = await ask('How do organizers create events?', { user: student });
    expect(res1.intent).toBe('info_how_events_work');
    expect(res1.answer).toMatch(/events in wevolunteer are created by organizers/i);
    expect(res1.answer).not.toMatch(/not something your account can/i);
    expect(res1.card).toBeNull();

    const res2 = await ask('What can admins do?', { user: student });
    expect(res2.intent).toBe('info_role_capabilities');
    expect(res2.answer).toMatch(/administrators/i);
    expect(res2.answer).not.toMatch(/not something your account can/i);

    const res3 = await ask('How does Auto Select work?', { user: student });
    expect(res3.intent).toBe('info_selection');
    expect(res3.answer).toMatch(/equalizer/i);
  });
});
