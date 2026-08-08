import crypto from 'crypto';
import { db } from '../db.js';

const BADGES = [
  {
    name: 'First Event',
    description: 'Attended your first volunteering event.',
    icon: '🌱',
    category: 'attendance',
    criteria_type: 'events_attended',
    criteria_value: 1,
    active: 1
  },
  {
    name: 'Dedicated Server',
    description: 'Completed 10 hours of service.',
    icon: '⭐',
    category: 'hours',
    criteria_type: 'hours',
    criteria_value: 10,
    active: 1
  },
  {
    name: 'Silver Award',
    description: 'Completed 25 hours of service.',
    icon: '🥈',
    category: 'hours',
    criteria_type: 'hours',
    criteria_value: 25,
    active: 1
  },
  {
    name: 'Gold Award',
    description: 'Completed 50 hours of service.',
    icon: '🥇',
    category: 'hours',
    criteria_type: 'hours',
    criteria_value: 50,
    active: 1
  },
  {
    name: 'Organizer Initiator',
    description: 'Created your first event.',
    icon: '🚀',
    category: 'organizer',
    criteria_type: 'events_created',
    criteria_value: 1,
    active: 1
  }
];

try {
  const existingCount = db.prepare('SELECT COUNT(*) as count FROM badges').get().count;
  if (existingCount === 0) {
    const insert = db.prepare(`
      INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const badge of BADGES) {
      insert.run(
        `badge-${crypto.randomUUID()}`,
        badge.name,
        badge.description,
        badge.icon,
        badge.category,
        badge.criteria_type,
        badge.criteria_value,
        badge.active,
        new Date().toISOString()
      );
    }
    console.log('Seeded initial badges.');
  } else {
    console.log('Badges already seeded.');
  }
} catch (err) {
  console.error('Failed to seed badges:', err);
}
