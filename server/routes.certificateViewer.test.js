import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `GET /api/certificates/:code` and its PDF.
 *
 * ── The property that matters most ──
 *
 * A certificate code is a BEARER CREDENTIAL (see `server/certificates.js`):
 * whoever holds the printout can verify it. That makes two failure modes
 * important, and neither is a crash.
 *
 * The first is somebody else's certificate being readable by code. These routes
 * are the only ones that emit a certificate in a form that can be downloaded and
 * handed on, so the scoping has to be in the query rather than in a comparison
 * the next refactor deletes.
 *
 * The second is subtler: a refusal that DISTINGUISHES "not yours" from "no such
 * code" turns the route into an oracle for which codes are live. Somebody
 * walking the space would learn nothing about whose a code is, but they would
 * learn that it exists — which is most of the way there when a code is printed
 * on a document with a name on it. Both answer 404, and this file asserts the
 * two responses are byte-identical rather than merely both 404.
 */
describe('one certificate, for the person who earned it', () => {
  let srv, owner, other, code;

  beforeAll(async () => {
    srv = await startTestServer();
    /* Priya is the seed's one volunteer with credited attendance on a completed
       event (`event-pantry-past`), so she is the only account that HAS a
       certificate. Signing in as somebody with none would make every case below
       pass by having nothing to read — which the assertion just after this
       guards against explicitly. */
    owner = await srv.login('priya.patel@example.com');
    other = await srv.login('leo.chen@example.com');

    const list = await srv.call('GET', '/api/certificates', undefined, owner);
    expect(list.status).toBe(200);
    expect(
      list.body.length,
      'the seed has to give this volunteer at least one certificate, or every '
      + 'case below passes by having nothing to read',
    ).toBeGreaterThan(0);
    code = list.body[0].code;
    expect(code).toMatch(/^WEV-/);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('reading it', () => {
    it('returns everything the viewer draws, in one request', async () => {
      const res = await srv.call('GET', `/api/certificates/${code}`, undefined, owner);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(code);
      expect(res.body.title).toBeTruthy();
      expect(typeof res.body.hours).toBe('number');
      expect(res.body.organizerName).toBeTruthy();
      expect(res.body.volunteer.name).toBeTruthy();
      /* Both spellings of the destination: the absolute one is what the QR
         encodes and what a share sheet hands to another application; the label
         is what is printed, where a scheme is noise. */
      expect(res.body.verifyUrl).toContain(`/verify/${code}`);
      expect(res.body.verifyLabel).toContain(`/verify/${code}`);
      expect(res.body.verifyLabel.startsWith('http')).toBe(false);
    });

    it('carries a QR image, so the browser needs no encoder', async () => {
      const res = await srv.call('GET', `/api/certificates/${code}`, undefined, owner);
      expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
      /* Large enough to be a real code rather than an empty canvas. */
      expect(res.body.qr.length).toBeGreaterThan(500);
    });

    it('accepts the code in any case, as it is typed off paper', async () => {
      const res = await srv.call('GET', `/api/certificates/${code.toLowerCase()}`, undefined, owner);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(code);
    });

    it('refuses an unauthenticated caller', async () => {
      /* The public route for a stranger holding a printout is
         `/api/certificates/verify/:code`, and it discloses only what is on the
         face of the document. This one is the owner's. */
      expect((await srv.call('GET', `/api/certificates/${code}`)).status).toBe(401);
    });

    it('answers somebody else identically to a code that does not exist', async () => {
      const notMine = await srv.call('GET', `/api/certificates/${code}`, undefined, other);
      const notReal = await srv.call('GET', '/api/certificates/WEV-ZZZZ-ZZZZ', undefined, other);

      expect(notMine.status).toBe(404);
      expect(notReal.status).toBe(404);
      /* Byte-identical, not merely both 404: a different message is a different
         answer, and this route must not be able to confirm that a code is
         live. */
      expect(notMine.body).toEqual(notReal.body);
    });

    it('does not emit anything about the volunteer beyond the document', async () => {
      const res = await srv.call('GET', `/api/certificates/${code}`, undefined, owner);
      const body = JSON.stringify(res.body);
      /* The name and grade ARE on the certificate. An email address, a
         username, a user id and an address are not, and none of them has any
         business travelling with a document built to be handed to strangers. */
      expect(body).not.toMatch(/@example\.com/);
      expect(body).not.toMatch(/"email"/);
      expect(body).not.toMatch(/"userId"/);
      expect(body).not.toMatch(/"address"/);
    });
  });

  describe('downloading it', () => {
    it('serves a real PDF, as an attachment, uncacheable', async () => {
      const res = await fetch(`${srv.base}/api/certificates/${code}/pdf`, {
        headers: { Cookie: `wev_session=${owner}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/pdf');

      /* `attachment`, so the browser saves it instead of opening its own PDF
         viewer — which is the reading experience this whole feature replaced. */
      const disposition = res.headers.get('content-disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain(code);

      /* Private and unstored: this is one person's document, and a shared cache
         holding it is a disclosure nobody would ever see happen. */
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('cache-control')).toContain('private');

      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(bytes.subarray(-6).toString('latin1')).toContain('%%EOF');
    });

    it('names the file for the code and never for the volunteer', async () => {
      const res = await fetch(`${srv.base}/api/certificates/${code}/pdf`, {
        headers: { Cookie: `wev_session=${owner}` },
      });
      const disposition = res.headers.get('content-disposition');
      /* A file called `certificate-leo-chen.pdf` in a shared Downloads folder
         discloses something its owner did not choose to. */
      expect(disposition.toLowerCase()).not.toContain('priya');
      expect(disposition.toLowerCase()).not.toContain('patel');
    });

    /**
     * What the artefact that leaves the building actually says.
     *
     * The JSON payload is asserted for absent PII above, but the PDF is the
     * thing a student emails to a college — it is the copy that travels, and it
     * is built from a different code path. Structurally it can only contain what
     * the route hands the builder, which is the point: this pins that, so a
     * future field added "just for the footer" fails here rather than in
     * somebody's inbox.
     */
    it('contains the certificate and no other fact about the volunteer', async () => {
      const res = await fetch(`${srv.base}/api/certificates/${code}/pdf`, {
        headers: { Cookie: `wev_session=${owner}` },
      });
      const bytes = Buffer.from(await res.arrayBuffer());

      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: false,
        standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
      }).promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join('');

      /* Present: the document's own claims. */
      expect(text).toContain('Priya Patel');
      expect(text).toContain(code);

      /* Absent: everything that is about the ACCOUNT rather than the service. */
      expect(text).not.toMatch(/@/);
      expect(text.toLowerCase()).not.toContain('priyapatel');
      expect(text.toLowerCase()).not.toContain('user-student');
      expect(text.toLowerCase()).not.toContain('password');
    });

    it('refuses somebody else the file, the same way it refuses the JSON', async () => {
      const res = await fetch(`${srv.base}/api/certificates/${code}/pdf`, {
        headers: { Cookie: `wev_session=${other}` },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('refuses an unauthenticated download', async () => {
      const res = await fetch(`${srv.base}/api/certificates/${code}/pdf`);
      expect(res.status).toBe(401);
    });
  });

  describe('the public verification route is unchanged', () => {
    it('still verifies a code with no session, and still withholds the grade', async () => {
      /* The viewer work must not have altered what a stranger holding a
         printout can see. `grade` is deliberately absent here — the code proves
         possession of the paper, not who is holding it. */
      const res = await srv.call('GET', `/api/certificates/verify/${code}`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.volunteerName).toBeTruthy();
      expect(res.body.grade).toBeUndefined();
    });
  });

  /**
   * ── The certificate whose event was called off afterwards ──
   *
   * `certificates.cancelled.test.js` pins the issuing rule: never issue for a
   * called-off event, and never revoke one already issued — "There is no option
   * to void a certificate" is a sentence in a hash-pinned policy, and a case in
   * that file is named for a printout continuing to verify.
   *
   * This viewer was the one surface that broke it. `getCertificateForOwner`
   * carried the certificate LIST's exclusion of a cancelled event, so the
   * public check answered `valid` with the hours to anybody holding the code,
   * while the student named on the document got 404 from their own application.
   */
  /**
   * ── The certificate whose event was called off afterwards ──
   *
   * `certificates.cancelled.test.js` pins the issuing rule: never issue for a
   * called-off event, and never revoke one already issued — "There is no option
   * to void a certificate" is a sentence in a hash-pinned policy, and a case in
   * that file is named for a printout continuing to verify.
   *
   * This viewer was the one surface that broke it. `getCertificateForOwner`
   * carried the certificate LIST's exclusion of a cancelled event, so the
   * public check answered `valid` with the hours to anybody holding the code,
   * while the student named on the document got 404 from their own application.
   *
   * Declared LAST in the file and on the SHARED server, deliberately. Calling
   * `startTestServer()` a second time here is refused by its own guard — db.js
   * opens its connection at module scope, so the second instance would bind to
   * a real database file. Cancelling mutates seed state, so nothing may run
   * after this block.
   */
  describe('an event called off after the certificate was issued', () => {
    beforeAll(async () => {
      const list = await srv.call('GET', '/api/certificates', undefined, owner);
      const mine = list.body.find(c => c.code === code);
      expect(mine?.eventId, 'the certificate under test has no event').toBeTruthy();

      const { db } = await import('./db.js');
      await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(mine.eventId);
    }, 60000);

    it('is still readable by the person named on it', async () => {
      const res = await srv.call('GET', `/api/certificates/${code}`, undefined, owner);
      expect(res.status, 'the holder was refused their own certificate').toBe(200);
      expect(res.body.code).toBe(code);
      expect(res.body.hours).toBeGreaterThan(0);
    });

    it('says so, rather than showing the document with no explanation', async () => {
      /* The hours are real and still verify; they are simply not in the
         student's totals. A viewer that showed one without the other would
         trade one contradiction for the opposite one. */
      const res = await srv.call('GET', `/api/certificates/${code}`, undefined, owner);
      expect(res.body.eventCancelled).toBe(true);
    });

    it('is still downloadable as the same PDF', async () => {
      const res = await srv.call('GET', `/api/certificates/${code}/pdf`, undefined, owner);
      expect(res.status).toBe(200);
    });

    it('still verifies for a stranger holding the code, exactly as before', async () => {
      /* The other half of the published position. Nothing here may turn into a
         revocation by the back door. */
      const res = await srv.call('GET', `/api/certificates/verify/${code}`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('still keeps it off the certificates list, which mirrors the transcript', async () => {
      /* The list's exclusion is correct and separate: a called-off event is not
         part of a service record. Only the viewer changed. */
      const list = await srv.call('GET', '/api/certificates', undefined, owner);
      expect(list.body.some(c => c.code === code)).toBe(false);
    });
  });
});
