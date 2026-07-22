import { app } from './app.js';
import { PORT, IS_PRODUCTION, DEMO_MODE } from './config.js';
import { initDatabase } from './db.js';
import { runNotificationSweep } from './utils.js';

if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production.');
  process.exit(1);
}
if (IS_PRODUCTION && DEMO_MODE) {
  console.error('FATAL: DEMO_MODE cannot be enabled in production.');
  process.exit(1);
}

initDatabase();

runNotificationSweep();
setInterval(runNotificationSweep, 15 * 60 * 1000);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SBVolunteers API Server listening on port ${PORT}`);
});
