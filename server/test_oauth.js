import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import oauthRoutes from './routes/oauthRoutes.js';
import authRoutes from './routes/authRoutes.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './config.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(oauthRoutes);
app.use(authRoutes);

describe('OAuth Routes', () => {
  let jwtState = '';
  let cookieHeader = '';
  let signupToken = '';

  it('GET /api/oauth/google/url generates URL and state cookie', async () => {
    const res = await request(app).get('/api/oauth/google/url');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.url);
    
    // Extract JWT state from URL
    const urlObj = new URL(res.body.url);
    jwtState = urlObj.searchParams.get('state');
    assert.ok(jwtState, 'Should contain state parameter in URL');

    const cookies = res.headers['set-cookie'];
    assert.ok(cookies, 'Should set cookies');
    
    // Find the state cookie
    const stateCookieStr = cookies.find(c => c.startsWith('wev_oauth_state_'));
    assert.ok(stateCookieStr, 'State cookie should be extracted');
    cookieHeader = stateCookieStr.split(';')[0]; // Key=Value
  });

  it('POST /api/oauth/google/callback fails with invalid state', async () => {
    const res = await request(app)
      .post('/api/oauth/google/callback')
      .send({ code: 'mock-code', state: 'wrong-state' })
      .set('Cookie', [cookieHeader]);
    
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('Invalid or expired state parameter'));
  });

  it('POST /api/oauth/google/callback requires signup for new user', async () => {
    // Generate new mock user JSON as code payload to trigger signup
    const mockPayload = JSON.stringify({
      email: `test_oauth_${Date.now()}@example.com`,
      sub: `mock-sub-${Date.now()}`,
      name: 'Test OAuth User'
    });

    const res = await request(app)
      .post('/api/oauth/google/callback')
      .send({ code: mockPayload, state: jwtState })
      .set('Cookie', [cookieHeader]);
    
    if (res.status !== 200) console.log(res.body);
    
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.action, 'signup_required');
    assert.ok(res.body.signupToken);
    
    signupToken = res.body.signupToken;
  });

  it('POST /api/auth/signup works with OAuth signupToken', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({
        email: 'this_will_be_ignored@example.com',
        name: 'Test OAuth User',
        username: `tu_${Date.now().toString().slice(-6)}`,
        role: 'student',
        grade: '10',
        signupToken: signupToken
      });
    if (res.status !== 201) {
      console.log('Signup error response:', res.body);
    }
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.user);
    assert.strictEqual(res.body.user.name, 'Test OAuth User');
  });

  it('POST /api/oauth/microsoft/callback works similarly', async () => {
    const urlRes = await request(app).get('/api/oauth/microsoft/url');
    const urlObj = new URL(urlRes.body.url);
    const msState = urlObj.searchParams.get('state');
    const msCookie = urlRes.headers['set-cookie'].find(c => c.startsWith('wev_oauth_state_')).split(';')[0];
    
    const mockPayload = JSON.stringify({
      email: `test_ms_${Date.now()}@example.com`,
      sub: `ms-mock-sub-${Date.now()}`,
      name: 'Microsoft User'
    });

    const res = await request(app)
      .post('/api/oauth/microsoft/callback')
      .send({ code: mockPayload, state: msState })
      .set('Cookie', [msCookie]);
    
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.action, 'signup_required');
  });
});
