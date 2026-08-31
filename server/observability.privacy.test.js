/**
 * Can telemetry be turned into an exfiltration channel?
 *
 * The question is not rhetorical. Automatic instrumentation records what the
 * semantic conventions tell it to, and MEASURED on these package versions that
 * includes the query string verbatim, the client's IP address twice, and the
 * real path. `telemetry.js` refuses all three for the log wire and explains why:
 * a URL carries search terms, addresses and email addresses, and an IP address
 * is personal data redaction does not cover — on a population that is mostly
 * minors.
 *
 * These tests hold the trace wire to the same bar, and they are written from the
 * attacker's side: everything below is a value a user can put into the
 * application through an ordinary form field or URL.
 */
import { describe, it, expect } from 'vitest';
import {
  scrubSpan, ScrubbingSpanProcessor, ALLOWED_SPAN_ATTRIBUTES, ALLOWED_EVENT_ATTRIBUTES,
} from './observability/spanAttributes.js';

function spanWith(attributes, events = []) {
  return { attributes: { ...attributes }, events, name: 'test', spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }) };
}

describe('the attributes automatic instrumentation records by default', () => {
  /* Exactly the attribute set observed from @opentelemetry/instrumentation-http
     on a request to /api/events/42?email=…&q=123+Maple+St. */
  const REAL_DEFAULTS = {
    'http.request.method': 'GET',
    'url.scheme': 'http',
    'server.address': 'wevolunteer-prod-01.internal',
    'network.peer.address': '::ffff:203.0.113.44',
    'network.peer.port': 52647,
    'network.protocol.version': '1.1',
    'user_agent.original': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
    'url.path': '/api/events/42',
    'url.query': 'email=chris.vale@school.org&q=123%20Maple%20St&token=secret123',
    'client.address': '::ffff:203.0.113.44',
    'server.port': 3000,
    'http.response.status_code': 200,
    'http.route': '/api/events/:id',
  };

  it('removes the query string, which is where the email and the address were', () => {
    const span = spanWith(REAL_DEFAULTS);
    scrubSpan(span);
    expect(span.attributes['url.query']).toBeUndefined();
    expect(JSON.stringify(span.attributes)).not.toContain('chris.vale@school.org');
    expect(JSON.stringify(span.attributes)).not.toContain('Maple');
    expect(JSON.stringify(span.attributes)).not.toContain('secret123');
  });

  it('removes both spellings of the client IP address', () => {
    const span = spanWith(REAL_DEFAULTS);
    scrubSpan(span);
    expect(span.attributes['client.address']).toBeUndefined();
    expect(span.attributes['network.peer.address']).toBeUndefined();
    expect(JSON.stringify(span.attributes)).not.toContain('203.0.113.44');
  });

  it('removes the real path, keeping the route pattern', () => {
    const span = spanWith(REAL_DEFAULTS);
    scrubSpan(span);
    expect(span.attributes['url.path']).toBeUndefined();
    expect(span.attributes['http.route']).toBe('/api/events/:id');
  });

  it('removes the server hostname, which in a district can name a building', () => {
    const span = spanWith(REAL_DEFAULTS);
    scrubSpan(span);
    expect(span.attributes['server.address']).toBeUndefined();
    expect(JSON.stringify(span.attributes)).not.toContain('internal');
  });

  it('removes the user agent', () => {
    const span = spanWith(REAL_DEFAULTS);
    scrubSpan(span);
    expect(span.attributes['user_agent.original']).toBeUndefined();
  });

  it('keeps exactly the useful four and nothing else', () => {
    const span = spanWith(REAL_DEFAULTS);
    scrubSpan(span);
    expect(Object.keys(span.attributes).sort()).toEqual([
      'http.request.method', 'http.response.status_code', 'http.route',
      'network.protocol.version', 'url.scheme',
    ]);
  });
});

describe('the allowlist fails closed', () => {
  it('drops an attribute nobody has thought of yet', () => {
    /* The premise of an allowlist: a future instrumentation, or a future version
       of one already here, adds an attribute in a minor release and nobody
       reviews it. It must not ship by default. */
    const span = spanWith({ 'http.route': '/x', 'some.future.attribute': 'anything at all' });
    scrubSpan(span);
    expect(span.attributes['some.future.attribute']).toBeUndefined();
  });

  it('drops attributes a caller invented under the wev. namespace', () => {
    const span = spanWith({ 'wev.userEmail': 'chris@school.org', 'wev.operation': 'event.signup' });
    scrubSpan(span);
    expect(span.attributes['wev.userEmail']).toBeUndefined();
    expect(span.attributes['wev.operation']).toBe('event.signup');
  });

  it('refuses arrays and objects outright rather than serialising them', () => {
    const span = spanWith({ 'http.route': ['a', 'b'], 'wev.operation': { toString: () => 'sneaky' } });
    scrubSpan(span);
    expect(span.attributes['http.route']).toBeUndefined();
    expect(span.attributes['wev.operation']).toBeUndefined();
  });

  it('is not fooled by a prototype-pollution key', () => {
    const span = spanWith({ '__proto__': 'x', 'constructor': 'y', 'prototype': 'z', 'http.route': '/ok' });
    scrubSpan(span);
    expect(span.attributes['http.route']).toBe('/ok');
    expect({}.polluted).toBeUndefined();
    expect(Object.keys(span.attributes)).toEqual(['http.route']);
  });

  it('does not allow a credential-shaped value through an allowed key', () => {
    /* An allowed key with a hostile value: `http.route` is code-declared in
       practice, but the redaction and the cap have to hold regardless. */
    const span = spanWith({ 'http.route': '/x'.padEnd(5000, 'y') });
    scrubSpan(span);
    expect(span.attributes['http.route'].length).toBeLessThanOrEqual(500);
  });
});

describe('span events — the second channel', () => {
  it('redacts an exception message carrying an email address', () => {
    const span = spanWith({}, [{
      name: 'exception',
      attributes: {
        'exception.type': 'ValidationError',
        'exception.message': 'Duplicate account for chris.vale@school.org',
      },
    }]);
    scrubSpan(span);
    const message = span.events[0].attributes['exception.message'];
    expect(message).not.toContain('chris.vale@school.org');
    expect(span.events[0].attributes['exception.type']).toBe('ValidationError');
  });

  it('drops an event attribute that is not on the event allowlist', () => {
    const span = spanWith({}, [{ name: 'exception', attributes: { 'db.user': 'wevolunteer_app', 'exception.type': 'E' } }]);
    scrubSpan(span);
    expect(span.events[0].attributes['db.user']).toBeUndefined();
    expect(span.events[0].attributes['exception.type']).toBe('E');
  });

  it('caps a stack trace rather than shipping an unbounded one', () => {
    const span = spanWith({}, [{ name: 'exception', attributes: { 'exception.stacktrace': 'at x\n'.repeat(5000) } }]);
    scrubSpan(span);
    expect(span.events[0].attributes['exception.stacktrace'].length).toBeLessThanOrEqual(4000);
  });
});

describe('the database statement', () => {
  it('keeps a parameterised statement, which carries no values', () => {
    const span = spanWith({ 'db.query.text': 'SELECT id FROM users WHERE email = $1' });
    scrubSpan(span);
    expect(span.attributes['db.query.text']).toBe('SELECT id FROM users WHERE email = $1');
  });

  it('redacts a statement that somehow has a value inlined', () => {
    /* `enhancedDatabaseReporting` is off, so this should not happen — which is
       exactly why it is worth a test: the guarantee should not rest on one
       option in one dependency staying at its default. */
    const span = spanWith({ 'db.query.text': "SELECT id FROM users WHERE email = 'chris.vale@school.org'" });
    scrubSpan(span);
    expect(span.attributes['db.query.text']).not.toContain('chris.vale@school.org');
  });
});

describe('ScrubbingSpanProcessor', () => {
  it('scrubs before anything downstream can see the span', () => {
    const seen = [];
    const processor = new ScrubbingSpanProcessor({
      onStart() {}, onEnd(s) { seen.push(JSON.stringify(s.attributes)); },
      forceFlush: async () => {}, shutdown: async () => {},
    });
    processor.onEnd(spanWith({ 'url.query': 'email=chris@school.org', 'http.route': '/x' }));
    expect(seen[0]).not.toContain('chris@school.org');
    expect(seen[0]).toContain('/x');
  });

  it('fails CLOSED: a span it cannot scrub is not forwarded', () => {
    /* The one place in this pipeline where failing open would be a disclosure
       rather than a gap, so it is the one place that drops rather than forwards. */
    const seen = [];
    const processor = new ScrubbingSpanProcessor({
      onStart() {}, onEnd(s) { seen.push(s); }, forceFlush: async () => {}, shutdown: async () => {},
    });
    const hostile = { get attributes() { throw new Error('nope'); }, events: [] };
    expect(() => processor.onEnd(hostile)).not.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('does not throw when the downstream processor throws', () => {
    const processor = new ScrubbingSpanProcessor({
      onStart() {}, onEnd() { throw new Error('downstream down'); },
      forceFlush: async () => {}, shutdown: async () => {},
    });
    expect(() => processor.onEnd(spanWith({ 'http.route': '/x' }))).not.toThrow();
  });
});

describe('the allowlists themselves', () => {
  it('contains no attribute whose name suggests an identifier or a credential', () => {
    /* A grep, as a test. It cannot prove the list is safe; it can stop the
       specific mistake of adding `wev.userId` at 2am and nobody noticing. */
    const forbidden = /email|password|token|secret|cookie|authorization|session|ip|address|url\.(query|full|path)|user_agent|body|payload/i;
    for (const key of ALLOWED_SPAN_ATTRIBUTES) {
      /* `db.namespace` and `wev.request_id` are the deliberate exceptions: a
         database name is code-declared, and a request id is the same opaque
         value `telemetry.js` already treats as an `id`. */
      if (key === 'db.namespace' || key === 'wev.request_id') continue;
      expect(key, `allowlisted attribute "${key}" looks like PII or a credential`).not.toMatch(forbidden);
    }
    for (const key of ALLOWED_EVENT_ATTRIBUTES) {
      expect(key).toMatch(/^exception\./);
    }
  });
});
