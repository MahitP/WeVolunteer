import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.WEV_DB_PATH || path.join(__dirname, '..', 'server', 'wevolunteer.db');

const email = process.argv[2];

if (!email) {
  console.error('Usage: node bin/make-admin.mjs <email>');
  process.exit(1);
}

try {
  const db = new DatabaseSync(dbPath);

  const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);

  if (!user) {
    console.error(`Error: User with email ${email} not found.`);
    console.error('Please have the user sign up first before promoting them.');
    process.exit(1);
  }

  if (user.role === 'admin') {
    console.log(`User ${email} is already an admin.`);
    process.exit(0);
  }

  db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  console.log(`Successfully promoted ${email} to admin.`);
} catch (error) {
  console.error('Database error:', error.message);
  process.exit(1);
}
