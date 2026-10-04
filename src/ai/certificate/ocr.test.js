import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A read that is abandoned leaves nothing running (final audit, Phase 6 review).
 *
 * The timeout or an abort could land while Tesseract was still starting. The
 * cleanup then found no worker to stop, the start finished anyway, and the
 * photo was recognised in the background after the student had been told it
 * could not be — with the worker never shut down, and the late failure of the
 * losing branch surfacing as an unhandled rejection.
 */

const worker = { recognize: vi.fn(), terminate: vi.fn(() => Promise.resolve()) };
let finishStart;
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(() => new Promise((resolve) => { finishStart = () => resolve(worker); })),
}));

const { recognizeText } = await import('./ocr.js');

beforeEach(() => {
  vi.clearAllMocks();
  worker.recognize.mockResolvedValue({ data: { text: 'Presented by: Environmental Club' } });
});

const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'cert.jpg', { type: 'image/jpeg' });
const tick = () => new Promise(r => setTimeout(r, 0));

describe('recognizeText', () => {
  it('reads a photo and stops the worker', async () => {
    const reading = recognizeText(photo());
    await tick(); finishStart();
    await expect(reading).resolves.toMatch(/Environmental Club/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('stops a worker that finishes starting after the read was abandoned, and reads nothing', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const controller = new AbortController();
    const reading = recognizeText(photo(), { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(reading).rejects.toThrow(/aborted/);

    finishStart();
    await tick(); await tick();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.recognize).not.toHaveBeenCalled();
    await tick();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
