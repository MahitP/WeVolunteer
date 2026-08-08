import express from 'express';
import crypto from 'crypto';
import { db } from '../db.js';
import { authenticateToken, formatUserResponse } from '../utils.js';
import { requireCap } from '../authz.js';
import { badgeService } from '../services/badgeService.js';

const router = express.Router();

// GET all badges available in the system
router.get('/api/badges', (req, res) => {
  try {
    const badges = db.prepare('SELECT * FROM badges WHERE active = 1 ORDER BY category, criteria_value').all();
    res.json({ badges });
  } catch (err) {
    console.error('Failed to get badges:', err);
    res.status(500).json({ error: 'Failed to get badges' });
  }
});

// GET user's earned badges
router.get('/api/users/:userId/badges', (req, res) => {
  try {
    const userBadges = db.prepare(`
      SELECT b.*, ub.earned_at
      FROM user_badges ub
      JOIN badges b ON ub.badge_id = b.id
      WHERE ub.user_id = ?
      ORDER BY ub.earned_at DESC
    `).all(req.params.userId);
    res.json({ badges: userBadges });
  } catch (err) {
    console.error('Failed to get user badges:', err);
    res.status(500).json({ error: 'Failed to get user badges' });
  }
});

// Admin: GET all badges including inactive
router.get('/api/admin/badges', authenticateToken, requireCap('event.moderate'), (req, res) => {
  try {
    const badges = db.prepare('SELECT * FROM badges ORDER BY created_at DESC').all();
    res.json({ badges });
  } catch (err) {
    console.error('Failed to get admin badges:', err);
    res.status(500).json({ error: 'Failed to load badges' });
  }
});

// Admin: POST create or update a badge
router.post('/api/admin/badges', authenticateToken, requireCap('event.moderate'), (req, res) => {
  const { id, name, description, icon, category, criteria_type, criteria_value, active } = req.body;
  if (!name || !description || !icon || !category || !criteria_type) {
    return res.status(400).json({ error: 'Missing required badge fields.' });
  }

  try {
    if (id) {
      db.prepare(`
        UPDATE badges SET name = ?, description = ?, icon = ?, category = ?, criteria_type = ?, criteria_value = ?, active = ?
        WHERE id = ?
      `).run(name, description, icon, category, criteria_type, criteria_value, active ? 1 : 0, id);
    } else {
      const newId = `badge-${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, name, description, icon, category, criteria_type, criteria_value, active ? 1 : 0, new Date().toISOString());
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save badge:', err);
    res.status(500).json({ error: 'Failed to save badge' });
  }
});

// Admin: POST award a badge manually
router.post('/api/admin/badges/award', authenticateToken, requireCap('event.moderate'), (req, res) => {
  const { userId, badgeId } = req.body;
  if (!userId || !badgeId) return res.status(400).json({ error: 'User and Badge required.' });

  try {
    const existing = db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?').get(userId, badgeId);
    if (existing) {
      return res.status(400).json({ error: 'User already has this badge.' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO user_badges (id, user_id, badge_id, earned_at, awarded_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(`ub-${crypto.randomUUID()}`, userId, badgeId, now, req.user.id);

    // Run evaluation to make sure stats match if needed, but manual is manual.
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to award badge:', err);
    res.status(500).json({ error: 'Failed to award badge' });
  }
});

export default router;
