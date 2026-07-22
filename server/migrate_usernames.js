import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'sbvolunteers.db');
const db = new DatabaseSync(dbPath);

console.log('Initializing database to run schema migrations...');
initDatabase();

console.log('Migrating missing usernames...');

// Read all users without a username
const users = db.prepare('SELECT id, name, email FROM users WHERE username IS NULL').all();

console.log(`Found ${users.length} users needing a username.`);

const updateUsername = db.prepare('UPDATE users SET username = ? WHERE id = ?');
const checkUsername = db.prepare('SELECT id FROM users WHERE username = ?');

let migrated = 0;

db.exec('BEGIN TRANSACTION');
try {
  for (const user of users) {
    let baseName = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    let username = baseName;
    let counter = 1;

    // Ensure uniqueness
    while (checkUsername.get(username)) {
      username = `${baseName}${counter}`;
      counter++;
    }

    updateUsername.run(username, user.id);
    migrated++;
    console.log(`- ${user.email} -> @${username}`);
  }
  db.exec('COMMIT');
  console.log(`\nSuccess: Migrated ${migrated} users.`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Migration failed:', err);
}
