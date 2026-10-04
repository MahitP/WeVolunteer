/**
 * Where the photo reader's language data is served (ruling 20).
 *
 * One constant shared by the browser module that asks for the file
 * (`ocr.js`) and the build that puts it there (`vite.config.js`), so the two
 * cannot drift. Imports nothing, so the config can read it under Node.
 *
 * The version is in the path because the file name cannot carry a hash:
 * Tesseract asks for `<langPath>/eng.traineddata.gz` and nothing else. A new
 * data version gets a new directory, so a long cache lifetime on the old one
 * can never serve stale data.
 */
export const OCR_LANGUAGE_VERSION = '4.0.0_best_int';
export const OCR_LANGUAGE_PATH = `/ocr/${OCR_LANGUAGE_VERSION}`;
export const OCR_LANGUAGE_FILE = 'eng.traineddata.gz';
