import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One logo, everywhere the product signs a page (N10, P2-47, FX-20).
 *
 * The shell, the error screens, /verify and a club's public page each print
 * the brand. The owner asked for the tile-and-name lockup and for the logo to
 * be the same everywhere; three of the four still drew the older wordmark.
 */
const READ = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SIGNED = [
  'src/App.jsx',
  'src/views/ErrorExperience/ErrorExperience.jsx',
  'src/views/CertificateVerification.jsx',
  'src/components/organizations/PublicOrganizationView.jsx',
];

describe('the lockup', () => {
  it.each(SIGNED)('%s signs with BrandLockup, not the drawn wordmark', (file) => {
    const src = READ(file);
    expect(src).toMatch(/<BrandLockup\b/);
    expect(src).not.toMatch(/<Wordmark\b/);
  });
});
