import { randomUUID } from 'crypto';

function addColumn(db, table, column, type) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!existing.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export default {
  version: 24,
  name: 'features_expansion',
  fileUrl: import.meta.url,
  
  up(db) {
    // 1. Profile Pictures
    addColumn(db, 'users', 'profile_picture_url', 'TEXT');
    addColumn(db, 'users', 'profile_picture_uploaded_at', 'TEXT');
    
    // 2. Two-Factor Authentication
    addColumn(db, 'users', 'two_factor_enabled', 'INTEGER DEFAULT 0');
    addColumn(db, 'users', 'two_factor_secret', 'TEXT');
    addColumn(db, 'users', 'two_factor_enabled_at', 'TEXT');
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    
    // 3. Badges System
    db.exec(`
      CREATE TABLE IF NOT EXISTS badges (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        icon TEXT NOT NULL,
        category TEXT NOT NULL,
        criteria_type TEXT NOT NULL,
        criteria_value INTEGER,
        active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_badges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        badge_id TEXT NOT NULL,
        earned_at TEXT NOT NULL,
        awarded_by TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(badge_id) REFERENCES badges(id) ON DELETE CASCADE,
        UNIQUE(user_id, badge_id)
      )
    `);

    // Seed default badges if not exist
    const existingBadges = db.prepare('SELECT COUNT(*) as count FROM badges').get().count;
    if (existingBadges === 0) {
      const now = new Date().toISOString();
      const insertBadge = db.prepare(`
        INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      insertBadge.run(`badge-${randomUUID()}`, 'First Step', 'Complete first volunteer opportunity', '🌱', 'Milestones', 'hours', 1, now);
      insertBadge.run(`badge-${randomUUID()}`, 'Helping Hand', 'Complete 10 volunteer hours', '🤝', 'Milestones', 'hours', 10, now);
      insertBadge.run(`badge-${randomUUID()}`, 'Community Champion', 'Complete 50 volunteer hours', '🏆', 'Milestones', 'hours', 50, now);
      insertBadge.run(`badge-${randomUUID()}`, 'Volunteer Legend', 'Complete 100+ volunteer hours', '👑', 'Milestones', 'hours', 100, now);
      insertBadge.run(`badge-${randomUUID()}`, 'Early Supporter', 'Joined during early platform period', '🌟', 'Participation', 'early_adopter', 0, now);
      insertBadge.run(`badge-${randomUUID()}`, 'Reliable Volunteer', 'High attendance rate', '⭐', 'Participation', 'attendance_rate', 90, now);
      insertBadge.run(`badge-${randomUUID()}`, 'Organizer', 'Created approved opportunities', '📋', 'Leadership', 'events_created', 1, now);
    }
  },
};
