/**
 * The security headers this application asks browsers to enforce, in one place.
 *
 * ── Why these options live outside app.js ──
 *
 * They are consumed twice. Express applies them to every response it writes
 * (app.js), and `bin/nginx-security-headers.mjs` renders the same headers into
 * `deploy/nginx/wevolunteers-security-headers.conf` for the documents nginx
 * serves itself — which in production is the SPA page, the one response a
 * Content-Security-Policy actually protects. Before that file existed the policy
 * below reached only JSON, and the page shipped with none: observed on the live
 * site, not inferred. One source, rendered twice, and a test that fails when the
 * two copies disagree (server/nginxSecurityHeaders.test.js).
 */
export const HELMET_OPTIONS = {
  /**
   * CSP was disabled outright in v1.0, which left cross-site scripting with no
   * mitigation at all — the same threat that motivated moving the session token
   * out of localStorage. An HttpOnly cookie stops an injected script *reading*
   * the session; it does nothing to stop the script running and making
   * authenticated same-origin requests with it. This directive set is the half
   * of that pair that addresses the vector rather than the consequence.
   */
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],

      /**
       * No 'unsafe-inline'. This is the directive that matters: it is what
       * stops an injected <script> from executing. Stage 3's theme pre-paint
       * script is an external file in public/ specifically to satisfy this.
       *
       * `cdn.amplitude.com` is here because `initAll` loads Amplitude's
       * engagement bundle from it at runtime. It is a third-party script origin
       * and therefore the most consequential line in this block — it is listed
       * only because the SDK cannot function without it, and it stays inert
       * while no API key is configured.
       */
      /**
       * `'wasm-unsafe-eval'` is what lets the on-device AI runtime compile its
       * WebAssembly module. Without it the browser refuses every
       * `WebAssembly.compile`/`instantiate` in the page and local inference
       * cannot start at all — there is no way to ship that feature without this
       * token.
       *
       * It is narrower than it reads. `'wasm-unsafe-eval'` permits compiling
       * WebAssembly and nothing else; it does NOT restore `eval()`, `new
       * Function()`, or inline script. Those remain refused, which is the
       * property this directive block exists to hold. An injected script still
       * cannot execute — and a script that cannot execute cannot reach
       * WebAssembly either.
       *
       * Unconditional rather than gated on a server flag, following the same
       * reasoning as the Amplitude host below: this widens what the page MAY do
       * and switches nothing on. Local AI is a build-time client flag
       * (VITE_LOCAL_AI), and the server cannot see it. Gating this on a second,
       * server-side flag would mean two settings that must agree, and the
       * failure when they disagree is the worst kind — the feature ships, the
       * page renders, and every model load is refused by the browser with an
       * error that names WebAssembly rather than the misconfiguration.
       */
      /**
       * `static.cloudflareinsights.com` — allowed by the owner's decision of
       * 2026-09-29, and it carries a disclosure obligation that travels with it.
       *
       * Cloudflare injects its Web Analytics beacon into HTML at the edge. This
       * directive used to block it, which logged a CSP error on every page load;
       * the owner chose to keep the analytics rather than switch it off in the
       * dashboard. Allowing it here is what makes that choice actually work.
       *
       * **What changed, and why the documents had to change with it.** The
       * beacon sends client-side page and timing data to Cloudflare. Cloudflare
       * already proxies every request and terminates TLS, so it was the most
       * unavoidable third party in the stack before this line existed — and it
       * was named in neither the Cookie Notice nor the Privacy Policy. Allowing
       * the beacon did not create that gap; it made it impossible to keep
       * ignoring. Both documents now describe Cloudflare's role.
       *
       * **If you ever remove this line**, the Cookie Notice's Cloudflare section
       * has to change with it — it says the beacon runs. A CSP that silently
       * stops matching a published document is the failure this comment exists
       * to prevent, in whichever direction it happens.
       */
      scriptSrc: [
        "'self'",
        "'wasm-unsafe-eval'",
        'https://cdn.amplitude.com',
        'https://static.cloudflareinsights.com',
      ],

      /**
       * Session Replay compresses in a worker created from a blob.
       * `workerSrc` falls back to `scriptSrc` and then `defaultSrc`, neither of
       * which allows `blob:` — so without this the recorder is refused with an
       * error that names the worker rather than Amplitude.
       */
      workerSrc: ["'self'", 'blob:'],

      /**
       * The client previously used 576 inline `style={{}}` blocks, but they have been
       * refactored. The few remaining dynamic styles use element.style which is CSP safe.
       */
      styleSrc: ["'self'"],

      /* Bricolage Grotesque and Public Sans are bundled from the Fontsource
         packages. They came from Google Fonts until 2026-10-12, which sent
         Google every visitor's IP address; see src/selfHostedFonts.test.js. */
      fontSrc: ["'self'"],

      /**
       * data: covers the inline SVG favicon and any base64 image.
       *
       * No map provider is listed, deliberately. Tiles are served by this
       * application's `/tiles` proxy (routes/tileRoutes.js), so the page never
       * contacts a tile host — and a provider host left here would quietly
       * re-permit the direct fetch the proxy exists to end.
       */
      imgSrc: ["'self'", 'data:'],

      /**
       * The API is same-origin in both topologies: production serves the SPA
       * and the API from this process, and development proxies /api through
       * Vite.
       *
       * The Amplitude hosts are the exception, and they are listed because the
       * alternative is worse than listing them: without these the SDK fails
       * silently in production — the page renders, nothing errors visibly, and
       * every event is refused by the browser. That is a integration that looks
       * installed and measures nothing.
       *
       * These four are the hosts actually observed in a running session:
       * ingestion, the CDN bundle, the Session Replay config, and the
       * general-settings endpoint. Named individually rather than as a wildcard
       * on `amplitude.com`, so a future Amplitude product cannot start talking
       * to a new subdomain without somebody adding it here on purpose.
       *
       * This widens what the page MAY reach; it does not switch anything on.
       * Analytics stays inert unless VITE_AMPLITUDE_API_KEY is set at build
       * time, and .env.example ships it empty.
       */
      connectSrc: [
        "'self'",
        'https://api2.amplitude.com',
        'https://sr-client-cfg.amplitude.com',
        'https://gs.amplitude.com',
        'https://cdn.amplitude.com',

        /**
         * Where the Cloudflare beacon reports to.
         *
         * `static.cloudflareinsights.com` in `script-src` only lets the script
         * LOAD. It POSTs its measurements to `cloudflareinsights.com/cdn-cgi/rum`,
         * a different host, and without this line the script runs and every
         * report is refused — which is worse than blocking it outright, because
         * the console error moves rather than disappearing and the analytics
         * still collect nothing. Allow both or neither.
         */
        'https://cloudflareinsights.com',

        /**
         * Where the on-device AI models are downloaded from.
         *
         * `huggingface.co` serves two things: the metadata API, which is where
         * the expected byte length and SHA-256 of every model file come from,
         * and the `/resolve/` URL that 302s to the CDN.
         *
         * ── The wildcard, and why it is not the pattern above ──
         *
         * The Amplitude hosts are named individually precisely so a new
         * subdomain cannot be reached without somebody adding it on purpose,
         * and the same instinct applies here. It does not survive contact with
         * how Hugging Face actually serves files. Measured on 2026-08-15, a
         * `/resolve/` request redirects to `us.aws.cdn.hf.co` — a
         * region-and-provider-specific host, and Hugging Face's own
         * documentation warns these hostnames may change without notice.
         *
         * Pinning the one observed host would mean a student routed to a
         * different region gets a refused request instead of a model, with no
         * error anybody would connect to this file. So the wildcard is scoped
         * to the `cdn.` label rather than to `hf.co`: it covers the regional
         * variants of the content-delivery subtree and nothing else. A future
         * Hugging Face *product* on some other `hf.co` subdomain is still
         * refused, which is the property the Amplitude comment is protecting.
         *
         * ── If this ever needs to go away ──
         *
         * Self-hosting the weights removes both lines and returns connect-src
         * to same-origin. Client-side that is one constant, `MODEL_BASE_URL` in
         * `src/ai/models.js`; nothing else knows where the files come from.
         *
         * As with Amplitude, this widens what the page MAY reach and switches
         * nothing on. Nothing is fetched unless VITE_LOCAL_AI is set at build
         * time AND somebody chooses a model.
         */
        'https://huggingface.co',
        'https://*.cdn.hf.co',
      ],

      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },

  /**
   * `DENY`, to say what `frame-ancestors 'none'` above already says.
   *
   * helmet's default is `SAMEORIGIN`. A browser that honours CSP ignores
   * X-Frame-Options when frame-ancestors is present, so this changes nothing
   * there; a browser that only reads the older header was being told that
   * same-origin framing is allowed, which is the one thing the CSP forbids. No
   * page of this application frames another.
   */
  frameguard: { action: 'deny' }
};

/**
 * The Referrer-Policy for DOCUMENTS, which deliberately differs from helmet's
 * `no-referrer` above.
 *
 * helmet's value is right for an API response and wrong for a page. A page's
 * policy governs the requests it makes, and the Fetch standard serializes the
 * `Origin` header of a same-origin POST as `null` when that policy is
 * `no-referrer` — which this application's CORS layer refuses, so every write
 * from the SPA could fail with 403 in a browser that follows the letter of the
 * standard. Chrome was checked and sends the real origin; other engines were not
 * available to check, and the page has been served with this value in
 * production without a report. It also keeps map and link destinations able to
 * see which site sent a visitor, which OpenStreetMap's tile policy asks of web
 * clients. Same-origin requests still carry the full URL; cross-origin ones
 * carry only the origin.
 */
export const DOCUMENT_REFERRER_POLICY = 'strict-origin-when-cross-origin';
