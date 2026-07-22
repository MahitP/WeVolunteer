import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, initDatabase } from './db.js';
import { runNotificationSweep } from './utils.js';

// Import Routes
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import applicationRoutes from './routes/applicationRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import contentRoutes from './routes/contentRoutes.js';

const app = express();
const PORT = Number(process.env.API_PORT) || 5050;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEMO_MODE = process.env.DEMO_MODE === 'true';
export const JWT_SECRET = process.env.JWT_SECRET || 'sbvolunteers_secret_key_12345';
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production.');
  process.exit(1);
}
if (IS_PRODUCTION && DEMO_MODE) {
  console.error('FATAL: DEMO_MODE cannot be enabled in production.');
  process.exit(1);
}

export const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
export const VALID_CATEGORIES = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

// Application Configs
export const APP_NAME = process.env.APP_NAME || 'SBVolunteers';
export const SCHOOL_NAME = process.env.SCHOOL_NAME || 'South Brunswick, NJ';
export const MAX_AUTO_SELECT_APPLICANTS = Number(process.env.MAX_AUTO_SELECT_APPLICANTS) || 100;
export const DEFAULT_EMAIL_FROM = `"${APP_NAME}" <noreply@sbvolunteers.org>`;

initDatabase();

if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 10000 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api', apiLimiter);

// Mount Routes
app.use(authRoutes);
app.use(eventRoutes);
app.use(applicationRoutes);
app.use(attendanceRoutes);
app.use(adminRoutes);
app.use(contentRoutes);

// Unknown API routes get JSON instead of an HTML 404 page
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Last-resort error handler
app.use((err, req, res, next) => {
  if (String(err.message).startsWith('Origin not allowed by CORS')) {
    console.warn(err.message);
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  console.error('Unhandled error:', err);
  const status = err.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Invalid JSON' : 'Internal server error' });
});

// Production: Serve the frontend
if (IS_PRODUCTION) {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      res.status(404).json({ error: 'Endpoint not found' });
    }
  });
}

// Health Check
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected', version: '2.0.0' });
  } catch (err) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

// Notifications
runNotificationSweep();
setInterval(runNotificationSweep, 15 * 60 * 1000);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SBVolunteers API Server listening on port ${PORT}`);
});
