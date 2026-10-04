import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The "Create account" button stays where it is while somebody types
 * (owner ruling 25, final audit Phase 5).
 *
 * The confirm-password status line was empty until the first character and
 * then gained a line ("Passwords match"), pushing the button down under a
 * pointer already on its way to it — measured in the walk, the click landed
 * on the hint. Every status line under the sign-in fields now always holds a
 * sentence, as the email line already did.
 */
const src = fs.readFileSync(path.join(process.cwd(), 'src/views/Signup.jsx'), 'utf8');

describe('the sign-in method step', () => {
  it('never leaves the confirm-password status empty', () => {
    expect(src).not.toMatch(/!form\.confirmPassword \? ''/);
    expect(src).toMatch(/!form\.confirmPassword \? 'Type the same password again\.'/);
  });
});
