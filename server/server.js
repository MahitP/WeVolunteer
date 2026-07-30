import { app } from './app.js';
import { PORT, IS_PRODUCTION, DEMO_MODE } from './config.js';
import { createServer } from 'http';
import { initSocketServer } from './realtime/socketServer.js';
import { initDatabase } from './db.js';
import { runNotificationSweep } from './utils.js';

// The JWT_SECRET guard that used to sit here has been removed as dead code.
// config.js now throws unconditionally when the secret is missing, and it is
// evaluated during the import above — so this check could never be reached,
// and its message ("...must be set in production") contradicted the actual
// behaviour, which requires the secret in every environment.
if (IS_PRODUCTION && DEMO_MODE) {
  console.error('FATAL: DEMO_MODE cannot be enabled in production.');
  process.exit(1);
}

import { startNotificationWorker } from './workers/notificationWorker.js';
import { startExportWorker } from './workers/exportWorker.js';

initDatabase();

runNotificationSweep();
setInterval(runNotificationSweep, 15 * 60 * 1000);
startNotificationWorker();
startExportWorker();

const httpServer = createServer(app);
initSocketServer(httpServer);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`WeVolunteer API Server listening on port ${PORT}`);
});
