import { describe, it, expect, beforeEach } from 'vitest';
import { verifyModel, sha256Hex, forgetVerifications, IntegrityError } from './integrity.js';
import { SHA256_MAX_BYTES } from './models.js';

/** SHA-256 of the three bytes "abc" — a published constant, not one we compute. */
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function model(overrides = {}) {
  return {
    id: 'test-model',
    version: 1,
    bytes: 3,
    sha256: ABC_SHA256,
    ...overrides,
  };
}

/** Size is all the length check reads, so oversize cases need no real bytes. */
const sized = size => ({ size });

beforeEach(() => {
  forgetVerifications();
});

describe('sha256Hex', () => {
  it('produces lower-case hex matching the published digest', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(ABC_SHA256);
  });
});

describe('length checking', () => {
  it('refuses a file that is not the expected size', async () => {
    /**
     * The failure that actually happens: a tab closed mid-download leaves a
     * short file in the cache. It must be caught before the bytes reach the
     * inference runtime, where the error would name a GGUF parse failure and
     * point at the wrong thing entirely.
     */
    await expect(verifyModel(model(), [new Blob(['ab'])])).rejects.toThrow(IntegrityError);
  });

  it('reports both sizes so the error can say what went wrong', async () => {
    const err = await verifyModel(model(), [new Blob(['ab'])]).catch(e => e);
    expect(err.expected).toBe(3);
    expect(err.actual).toBe(2);
  });

  it('checks length even for models too large to digest', async () => {
    /* The digest is bounded; the length check is not. A truncated 940 MB model
       must still be refused. */
    const big = model({ bytes: SHA256_MAX_BYTES + 1000 });
    await expect(verifyModel(big, [sized(SHA256_MAX_BYTES)])).rejects.toThrow(IntegrityError);
  });
});

describe('digest checking', () => {
  it('verifies a small model against the registry digest', async () => {
    expect(await verifyModel(model(), [new Blob(['abc'])]))
      .toEqual({ checked: true, status: 'verified' });
  });

  it('refuses a file of the right length whose contents differ', async () => {
    /**
     * The case length alone cannot catch, and the reason the digest is worth
     * having at all when a third party serves the bytes.
     */
    await expect(verifyModel(model(), [new Blob(['xyz'])])).rejects.toThrow(/checksum/);
  });

  it('skips the digest above the size threshold, and says so', async () => {
    /* WebCrypto cannot hash incrementally, so hashing the largest model would
       need it fully resident. Skipping is deliberate and must be reported
       rather than silently reading as "verified". */
    const big = model({ bytes: SHA256_MAX_BYTES + 1 });
    expect(await verifyModel(big, [sized(SHA256_MAX_BYTES + 1)]))
      .toEqual({ checked: false, status: 'too-large' });
  });

  it('skips a split model rather than hashing the concatenation', async () => {
    const split = model({ bytes: 6 });
    expect(await verifyModel(split, [new Blob(['abc']), new Blob(['def'])]))
      .toEqual({ checked: false, status: 'multi-shard' });
  });
});

describe('remembering a verification', () => {
  it('does not re-hash a file it has already verified', async () => {
    const m = model();
    expect((await verifyModel(m, [new Blob(['abc'])])).status).toBe('verified');
    expect((await verifyModel(m, [new Blob(['abc'])])).status).toBe('already-checked');
  });

  it('re-hashes when forced, which is what a failed load does', async () => {
    const m = model();
    await verifyModel(m, [new Blob(['abc'])]);
    expect((await verifyModel(m, [new Blob(['abc'])], { force: true })).status).toBe('verified');
  });

  it('forgets the record when the model version changes', async () => {
    /* The record is keyed on id AND version, so republishing a model under a
       new version re-verifies rather than trusting the previous file's record. */
    await verifyModel(model(), [new Blob(['abc'])]);
    expect((await verifyModel(model({ version: 2 }), [new Blob(['abc'])])).status)
      .toBe('verified');
  });

  it('re-verifies after the records are cleared', async () => {
    const m = model();
    await verifyModel(m, [new Blob(['abc'])]);
    forgetVerifications();
    expect((await verifyModel(m, [new Blob(['abc'])])).status).toBe('verified');
  });

  it('leaves unrelated storage keys alone when clearing', async () => {
    window.localStorage.setItem('wevol-theme', 'dark');
    await verifyModel(model(), [new Blob(['abc'])]);
    forgetVerifications();
    expect(window.localStorage.getItem('wevol-theme')).toBe('dark');
  });
});
