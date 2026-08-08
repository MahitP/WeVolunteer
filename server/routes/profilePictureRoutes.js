import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { db } from '../db.js';
import { authenticateToken, formatUserResponse } from '../utils.js';

const router = express.Router();

const UPLOADS_DIR = path.join(process.cwd(), 'public', 'uploads', 'avatars');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Store in memory first so we can process with sharp before saving
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed.'));
    }
  }
});

router.post('/api/users/me/profile-picture', authenticateToken, upload.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided' });
  }

  try {
    const filename = `${req.user.id}-${Date.now()}.webp`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Process image: resize, crop to square, convert to webp (strips metadata)
    await sharp(req.file.buffer)
      .resize(400, 400, {
        fit: sharp.fit.cover,
        position: sharp.strategy.entropy
      })
      .webp({ quality: 80 })
      .toFile(filepath);

    const relativeUrl = `/uploads/avatars/${filename}`;

    const now = new Date().toISOString();
    
    // Update user in DB
    db.prepare('UPDATE users SET profile_picture_url = ?, profile_picture_uploaded_at = ? WHERE id = ?')
      .run(relativeUrl, now, req.user.id);

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    
    res.json({ success: true, user: formatUserResponse(fresh) });
  } catch (err) {
    console.error('Profile picture upload error:', err);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

router.delete('/api/users/me/profile-picture', authenticateToken, (req, res) => {
  try {
    const userRow = db.prepare('SELECT profile_picture_url FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });
    
    // Delete the file if it exists locally
    if (userRow.profile_picture_url && userRow.profile_picture_url.startsWith('/uploads/')) {
      const oldPath = path.join(process.cwd(), 'public', userRow.profile_picture_url);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    db.prepare('UPDATE users SET profile_picture_url = NULL, profile_picture_uploaded_at = NULL WHERE id = ?')
      .run(req.user.id);

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, user: formatUserResponse(fresh) });
  } catch (err) {
    console.error('Profile picture delete error:', err);
    res.status(500).json({ error: 'Failed to delete profile picture' });
  }
});

export default router;
