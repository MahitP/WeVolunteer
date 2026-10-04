/**
 * Reading the text out of a photo of a certificate, on the device
 * (ruling 20, 2026-10-04).
 *
 * ── What this is for, and what it is not for ──
 *
 * The owner asked for photos to be read (P2-31). The objection on record is
 * that OCR is most likely to be confidently wrong about the hours, the one field
 * that lands on a record. The ruling keeps the objection and reads the rest:
 * this returns text, `readCertificate` takes the organization, activity and
 * date from it, and the hours are never filled from a photo. So nothing here
 * needs to be right about a number to be useful.
 *
 * ── Nothing leaves the device, and nothing comes from a CDN ──
 *
 * Tesseract.js fetches its worker, its WebAssembly core and its language data
 * from jsDelivr unless told otherwise. All three are handed to it from this
 * origin instead, emitted by the build like the Welly AI engine:
 *
 *   • the worker script, run as a file rather than a blob (`workerBlobURL`);
 *   • one core, chosen here: the SIMD build where the browser has SIMD, and the
 *     plain build where it does not. Both are the LSTM-only builds, the engine
 *     the language data below is for;
 *   • the English data (`4.0.0_best_int`, about 3 MB), at `OCR_LANGUAGE_PATH`
 *     on this origin. Tesseract asks for it by a fixed name
 *     (`eng.traineddata.gz`), which a hashed build asset cannot have, so
 *     `vite.config.js` serves and emits it there from the pinned npm package.
 *     Handing it over as bytes instead was tried, and Tesseract 7 then read
 *     the bytes as the language's NAME and refused to start.
 *
 * About 7 MB in all, downloaded the first time somebody chooses a photo and
 * kept by the browser's HTTP cache after that (the engine's file names are
 * hashed, and the data's path carries its version).
 * `cacheMethod: 'none'` stops Tesseract keeping a second copy in IndexedDB.
 * The photo itself is read into the worker and dropped; there is no upload.
 *
 * ── Bounded ──
 *
 * A phone photo is 12 megapixels and recognition time grows with it, so the
 * image is scaled to at most 2,000 pixels on its long side first, which is
 * more than enough for certificate type. The whole read is bounded in time,
 * starting the worker included: a worker that fails to start reports it
 * through `errorHandler` and would otherwise leave the promise pending for
 * ever, which is what the first real run did. The worker is terminated
 * whatever happens.
 */

import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreSimdUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import corePlainUrl from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import { OCR_LANGUAGE_PATH } from './ocrAssets.js';

/** Long edge, in pixels, the photo is scaled down to before recognition. */
export const MAX_EDGE = 2000;

/** How long a read may take before it is abandoned. Phones are slow at this. */
export const OCR_TIMEOUT_MS = 60000;

/**
 * Whether this browser's WebAssembly has SIMD.
 *
 * The smallest module that uses a SIMD instruction, as `wasm-feature-detect`
 * writes it. `validate` compiles nothing and runs nothing.
 */
function hasSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
      10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}

/**
 * The photo, no larger than it needs to be.
 *
 * `createImageBitmap` applies the photo's own orientation, so a picture taken
 * sideways is read the right way up. Where it or a canvas is missing, the file
 * goes to Tesseract as it is: slower, not wrong.
 */
async function scaled(file) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const ratio = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close?.();
  }
}

/**
 * The text in a photo, as plain lines.
 *
 * Throws on any failure (no WebAssembly, a worker that will not start, a read
 * that runs out of time). `readCertificate` turns that into a note telling the
 * student to type the details in.
 */
export async function recognizeText(file, { signal } = {}) {
  let timer;
  let worker = null;
  const abandon = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), OCR_TIMEOUT_MS);
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  /* Settled by the race below, or never: a late abort must not surface as an
     unhandled rejection after the read has already finished. */
  abandon.catch(() => {});

  const read = async () => {
    const { createWorker } = await import('tesseract.js');
    let failStart;
    const startFailed = new Promise((_, reject) => { failStart = reject; });
    startFailed.catch(() => {});
    const starting = createWorker('eng', 1 /* LSTM only */, {
      workerPath: workerUrl,
      corePath: hasSimd() ? coreSimdUrl : corePlainUrl,
      langPath: new URL(OCR_LANGUAGE_PATH, window.location.origin).href,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      errorHandler: err => failStart(new Error(String(err?.message || err || 'worker failed'))),
    });
    worker = await Promise.race([starting, startFailed]);
    const image = await scaled(file);
    const { data } = await Promise.race([worker.recognize(image), startFailed]);
    return String(data?.text ?? '');
  };

  try {
    return await Promise.race([read(), abandon]);
  } finally {
    clearTimeout(timer);
    await worker?.terminate().catch(() => {});
  }
}
