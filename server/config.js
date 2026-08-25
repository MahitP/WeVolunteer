/**
 * All environment-derived configuration, in one place with no side effects.
 *
 * Routers import from here rather than from server.js, so that importing a
 * router does not boot a listener, open the production database, or start the
 * notification sweep. That is what makes route tests possible.
 */

import { readFileSync } from 'node:fs';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEMO_MODE = process.env.DEMO_MODE === 'true';
export const PORT = Number(process.env.API_PORT) || 5050;

/**
 * Session signing secret.
 *
 * Every session cookie in the system is signed with this. If it is guessable,
 * anyone can mint a token for any account — including an administrator — so a
 * weak value here defeats every other control in this file.
 *
 * Three things are enforced, and the split between them matters:
 *
 *   • Missing, in any environment → fatal. Unchanged.
 *   • A known placeholder or an obviously weak value, in PRODUCTION → fatal.
 *     The previous check only caught a missing secret, so shipping with the
 *     literal `your-super-secret-jwt-key` from .env.example passed silently.
 *     That is the realistic failure: not an empty variable, but a template value
 *     nobody replaced.
 *   • The same in development → a loud warning, not a crash. Refusing to boot
 *     locally over a weak secret would make people paste a real production
 *     secret into their dev .env to get past it, which is worse.
 *
 * The dev fallback lives here rather than in package.json's `dev` script. It was
 * there as `JWT_SECRET=${JWT_SECRET:-…}`, which set a shell variable — and a
 * shell variable takes precedence over `--env-file`, so it silently overrode a
 * real secret in .env. Development and production would then sign with different
 * keys, and setting a proper secret would appear to do nothing locally.
 */
const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

/** Values that indicate nobody chose a secret. Compared case-insensitively. */
const PLACEHOLDER_SECRETS = [
  'your-super-secret-jwt-key',
  'your-secret-key',
  'change-me',
  'changeme',
  'secret',
  'test',
  'test-secret',
  DEV_FALLBACK_SECRET
];

function describeWeakSecret(value) {
  if (!value) return null;
  const normalised = value.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.includes(normalised)) return 'it is a placeholder from the template';
  if (value.trim().length < 32) return `it is only ${value.trim().length} characters (32 minimum)`;
  // A single repeated character passes a length check but carries no entropy.
  if (new Set(value.trim()).size < 8) return 'it has too few distinct characters to carry real entropy';
  return null;
}

let resolvedSecret = process.env.JWT_SECRET;

if (!resolvedSecret) {
  if (IS_PRODUCTION) {
    throw new Error(
      'FATAL: JWT_SECRET must be set. Generate one with:\n'
      + '  openssl rand -base64 48\n'
      + 'and set it in the deployment environment (never in a committed file).'
    );
  }
  resolvedSecret = DEV_FALLBACK_SECRET;
  console.warn(
    '[config] JWT_SECRET is not set — using an insecure development fallback.\n'
    + '         Sessions signed with it are trivially forgeable. Set a real value in .env.'
  );
}

const weakness = describeWeakSecret(resolvedSecret);
if (weakness) {
  const message =
    `JWT_SECRET is not usable as a signing secret: ${weakness}.\n`
    + 'Every session cookie is signed with it, so a guessable value lets anyone\n'
    + 'mint a token for any account, including an administrator.\n'
    + 'Generate one with:  openssl rand -base64 48';
  if (IS_PRODUCTION) throw new Error(`FATAL: ${message}`);
  console.warn(`[config] WARNING: ${message}`);
}

export const JWT_SECRET = resolvedSecret;

/**
 * 2FA Encryption Key.
 * 
 * Used for AES-256-GCM encryption of TOTP secrets. Must be exactly a 32-byte
 * cryptographically random value encoded as a base64 string.
 * 
 * Generation: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
/**
 * AES-256 key for encrypting stored TOTP secrets, base64, 32 bytes.
 *
 * ── Why this does not `process.exit` ──
 *
 * It used to, from module scope, in development as well as production — with a
 * comment saying that failing was safer than falling back to plaintext. The
 * second half of that is right and is preserved below: there is no plaintext
 * path, and an unset key still stops a production boot.
 *
 * Exiting from a config module is the part that was wrong. `config.js` is
 * imported by almost every module in the server, including from inside tests
 * that deliberately clear `NODE_ENV` to exercise the production guards — and
 * `process.exit(1)` there kills the test runner rather than failing an
 * assertion. It took out ~100 tests across a dozen files that have nothing to do
 * with two-factor authentication, and the failures pointed at `health.test.js`
 * and `instanceLock.test.js` rather than at the key.
 *
 * So it follows the shape `JWT_SECRET` a few lines above already uses, for the
 * same reasons: a loud development fallback, and a THROW in production that
 * `server.js` catches and reports as a fatal boot guard. Deciding to end the
 * process belongs to the entry point, not to a module somebody imported for a
 * constant.
 *
 * The fallback is a fixed, publicly-known key. Secrets encrypted with it are not
 * protected from anybody who reads this file — which is true of the development
 * `JWT_SECRET` too, and is why both warn. What it buys is that the storage FORMAT
 * is identical in development and production, so the encrypt/decrypt path is
 * exercised rather than skipped.
 */
const DEV_TFA_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Refuse to boot when an env file defines TFA_ENCRYPTION_KEY more than once.
 *
 * Node's `--env-file` is LAST-WINS and silent about it. A local .env carried two
 * different keys this way until 2026-08-09: only the last could decrypt stored
 * secrets, every enrolled authenticator failed verification, and nothing in the
 * process said which key was in force. Until now the only thing standing between
 * that and a repeat was a comment in .env.example asking for exactly one line,
 * and a comment does not survive a hurried edit.
 *
 * This reads the files Node was actually launched with rather than inspecting
 * `process.env`, because by the time this module runs the duplicate has already
 * collapsed into a single value and the evidence is gone.
 *
 * Fatal everywhere, development included, on the same reasoning the malformed-key
 * check uses: there is no safe interpretation. The guard deliberately does NOT
 * pick a winner and carry on — choosing either line is a guess, and guessing
 * wrong makes every enrolled authenticator unrecoverable.
 */
function assertSingleTfaKeyDefinition() {
  const args = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  const files = args
    .map((arg) => /^--env-file(?:-if-exists)?=(.+)$/.exec(arg))
    .filter(Boolean)
    .map((m) => m[1]);

  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      /* `--env-file-if-exists` pointing at a missing file is a supported state,
         and an unreadable file is the launcher's problem to report, not ours. */
      continue;
    }

    /* Assignment lines only. A commented-out key is not a definition, and the
       warning comment in .env.example mentions the name several times. */
    const lines = contents.split('\n');
    const defined = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*(?:export\s+)?TFA_ENCRYPTION_KEY\s*=/.test(lines[i])) defined.push(i + 1);
    }

    if (defined.length > 1) {
      throw new Error(
        `FATAL: ${file} defines TFA_ENCRYPTION_KEY ${defined.length} times `
        + `(lines ${defined.join(', ')}). Node's --env-file is last-wins, so the `
        + 'final line silently shadows the rest and any secret encrypted under a '
        + 'different one stops decrypting.\n'
        + 'Keep exactly one. If you are unsure which is live, test one against a '
        + 'stored secret BEFORE deleting anything — removing the wrong line makes '
        + 'every enrolled authenticator unrecoverable.'
      );
    }
  }
}

function resolveTfaKey() {
  assertSingleTfaKeyDefinition();
  const configured = process.env.TFA_ENCRYPTION_KEY;

  if (!configured) {
    if (IS_PRODUCTION) {
      throw new Error(
        'FATAL: TFA_ENCRYPTION_KEY is not set. A 32-byte base64 AES-256 key is '
        + 'required to encrypt stored two-factor secrets. Generate one with:\n'
        + "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n"
        + 'and set it in the deployment environment (never in a committed file).'
      );
    }
    console.warn(
      '[config] TFA_ENCRYPTION_KEY is not set — using an insecure development key.\n'
      + '         Stored two-factor secrets are recoverable by anyone with this source.'
    );
    return DEV_TFA_KEY;
  }

  /* A malformed key is fatal everywhere, development included: unlike an absent
     one there is no safe interpretation, and silently falling back would encrypt
     with a different key than the operator believes they configured — which
     surfaces later as every stored secret failing to decrypt. */
  /**
   * Validated by re-encoding, because `Buffer.from(x, 'base64')` never throws.
   *
   * Node's decoder silently DROPS characters outside the base64 alphabet, so the
   * `try/catch` this replaced could not fire: `"!!!!not base64 at all!!!!…"`
   * decoded to whatever the surviving characters happened to mean, and the error
   * message naming base64 validity was unreachable. The 32-byte check caught most
   * of it by luck — a string that decodes to exactly 32 bytes got through with a
   * value the operator never configured.
   *
   * Round-tripping is the check the decoder does not give us: if re-encoding the
   * bytes does not reproduce the input, the input was not the base64 of those
   * bytes. Padding and whitespace are normalised first so a legitimately padded
   * or line-wrapped value is not rejected for cosmetics.
   */
  const normalised = configured.trim().replace(/\s+/g, '');
  const bytes = Buffer.from(normalised, 'base64');
  if (Buffer.from(bytes).toString('base64').replace(/=+$/, '') !== normalised.replace(/=+$/, '')) {
    throw new Error(
      'FATAL: TFA_ENCRYPTION_KEY is not valid base64. Generate one with: '
      + `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  if (bytes.length !== 32) {
    throw new Error(
      `FATAL: TFA_ENCRYPTION_KEY must decode to 32 bytes, got ${bytes.length}. `
      + 'AES-256 takes a 256-bit key.'
    );
  }

  /**
   * A key of the right SHAPE can still be no key at all.
   *
   * `JWT_SECRET` a hundred lines above refuses placeholders and low-entropy
   * values; this function only ever checked base64 validity and length. The
   * development key is valid base64 and decodes to exactly 32 bytes — every one
   * of them ZERO — so an operator who copied it from this file, or from a
   * tutorial, into `/etc/wevolunteer/wevolunteer.env` would have booted
   * production with AES-256 keyed on a published constant of all zeros, and
   * nothing would have said a word.
   *
   * Every stored two-factor secret is encrypted with this. A guessable key means
   * anybody who reads the database can mint valid codes for an administrator,
   * which is the entire thing the second factor exists to prevent.
   *
   * The distinct-byte floor rather than an equality check on the dev key alone:
   * a hand-typed "key" of repeated characters is the same defect wearing a
   * different value, and a real 32-byte random key has around thirty distinct
   * bytes. Eight is the same floor `describeWeakSecret` applies to JWT_SECRET.
   */
  const distinctBytes = new Set(bytes).size;
  const weakness = configured.trim() === DEV_TFA_KEY
    ? 'it is the development key published in this source file'
    : distinctBytes < 8
      ? `it has only ${distinctBytes} distinct byte values, so it carries no real entropy`
      : null;

  if (weakness) {
    const message =
      `TFA_ENCRYPTION_KEY is not usable as an encryption key: ${weakness}.\n`
      + 'Stored two-factor secrets are encrypted with it, so a guessable key lets\n'
      + 'anyone who reads the database mint valid codes for any account.\n'
      + "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";
    /* Fatal in production, loud in development — the same split JWT_SECRET
       uses, and for the same reason: refusing to boot locally over the
       documented dev key would push somebody to paste a real production key
       into their .env to get past it. */
    if (IS_PRODUCTION) throw new Error(`FATAL: ${message}`);
    console.warn(`[config] WARNING: ${message}`);
  }

  return configured;
}

export const TFA_ENCRYPTION_KEY = resolveTfaKey();

/**
 * Whether an administrator must hold a second factor to use their privileges.
 *
 * ── Why it defaults to ON ──
 *
 * It was introduced defaulting to OFF (`=== 'true'`, so `undefined` meant
 * false), guarded by the production throw below. That made production safe and
 * left everything that is not exactly `NODE_ENV=production` — staging, CI, a
 * pilot deployment, a demo in front of a school district — silently running
 * with administrator 2FA disabled, on a variable nobody had to mention.
 *
 * A security control whose default is "off" is off wherever somebody forgot,
 * and the places people forget are exactly the ones with real data and no
 * review. So `undefined` now means ENABLED, and switching it off is an explicit
 * `REQUIRE_ADMIN_2FA=false` that a reader can see in an env file.
 *
 * The production throw is kept even though the default now satisfies it: it
 * catches the case that actually matters, which is somebody setting it to
 * `false` for a local reason and that value reaching production.
 *
 * ── Why the escape hatch exists at all ──
 *
 * `npm run dev` seeds a demo database whose administrator fixtures have no
 * authenticator enrolled, and there is deliberately no code path that can enrol
 * one for them (see the demo-owner guard in db.js). Without a way to say so,
 * the seeded demo is a database nobody can sign into as an administrator.
 * `.env.development` sets it to false for that reason and only that reason.
 */
const rawRequireAdmin2FA = process.env.REQUIRE_ADMIN_2FA;
if (rawRequireAdmin2FA !== undefined && rawRequireAdmin2FA !== 'true' && rawRequireAdmin2FA !== 'false') {
  throw new Error(`FATAL: REQUIRE_ADMIN_2FA must be "true", "false", or undefined. Got: ${rawRequireAdmin2FA}`);
}
export const REQUIRE_ADMIN_2FA = rawRequireAdmin2FA !== 'false';

if (IS_PRODUCTION && !REQUIRE_ADMIN_2FA) {
  throw new Error(
    'FATAL: REQUIRE_ADMIN_2FA must not be "false" in production. '
    + 'Administrators hold every capability on the platform; a password alone is '
    + 'not enough to stand behind that. Remove the variable to get the safe default.'
  );
}

export const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
/**
 * Re-exported, not declared.
 *
 * `VALID_CATEGORIES` has been imported from here by `eventRoutes.js` since the
 * first release, so the name stays. What it names now comes from
 * `server/eventCategories.js`, which is the one place the vocabulary is written
 * and the only one the client can also read. A second literal here would be a
 * list to forget to update, and the symptom of forgetting is a category the
 * dropdown offers and the API refuses.
 */
export { VALID_CATEGORIES } from './eventCategories.js';

export const APP_NAME = process.env.APP_NAME || 'WeVolunteer';

/**
 * Which account the public About page names as running the platform.
 *
 * ── Why this is configuration and not a query ──
 *
 * `super_admin` is the ROLE that confers owner status, and nothing about that
 * changes here: the endpoint still requires the named account to hold it, so
 * this can only ever choose BETWEEN owners, never create one. But a deployment
 * can legitimately hold several — this one holds two, a person and a service
 * account, both created in the same seeding run with identical timestamps — and
 * "earliest created" then decays into an arbitrary tiebreak on the id. Featuring
 * whichever account sorted first is not a decision anybody made.
 *
 * So the deployment says who it is, in the same spirit as
 * `DOCUMENT_SIGNATORY`: which human is publicly answerable for this instance is
 * an editorial fact about the deployment, not something the schema knows.
 *
 * Unset falls back to the earliest active owner, so an install that never sets
 * it still names somebody rather than nobody.
 */
export const PLATFORM_OWNER_USERNAME = process.env.PLATFORM_OWNER_USERNAME || '';
export const MAX_AUTO_SELECT_DRAWS = Number(process.env.MAX_AUTO_SELECT_DRAWS) || 5;

/**
 * OAuth configuration.
 *
 * SECURITY — the mock transport.
 *
 * Both providers carry a test transport that skips the real code exchange and
 * takes the identity straight from the `code` parameter. Previously it switched
 * itself on whenever the client id was absent, via
 * `process.env.GOOGLE_CLIENT_ID || 'mock-client-id'`. That made a *missing*
 * environment variable — the single most likely deployment mistake there is —
 * silently turn the callback into an unauthenticated login-as-anyone endpoint:
 *
 *     POST /api/oauth/google/callback
 *     { "code": "{\"email\":\"admin@district.org\",\"sub\":\"1\"}", "state": "..." }
 *
 * The mock is now opt-in and impossible to reach in production. It requires
 * OAUTH_ALLOW_MOCK=true, and NODE_ENV must not be production. A production
 * process that sets the flag refuses to boot rather than starting insecure.
 *
 * ── Why the DEFAULT is now false, and not `!IS_PRODUCTION` ──
 *
 * It defaulted to on in every non-production process, and that turned out to be
 * the same mistake in a smaller costume. A developer with real Google
 * credentials in `.env` — which is the normal state for anyone testing the real
 * flow — pressed "Continue with Google", was redirected to Google, signed in for
 * real, came back to the callback, and got **"Mock User" / "mock@example.com"**
 * prefilled into the signup form. `verifyCallback` checks the flag BEFORE
 * attempting the code exchange, so the mock silently shadowed the working
 * credentials and the real integration could not be exercised at all.
 *
 * "Off unless asked for" is the only default that cannot do that. The suites
 * that genuinely need the transport set the variable themselves — see
 * `startTestServer` — which also makes each one say out loud that it is not
 * talking to a real provider.
 */
export const OAUTH_ALLOW_MOCK = process.env.OAUTH_ALLOW_MOCK === 'true';
if (OAUTH_ALLOW_MOCK && IS_PRODUCTION) {
  throw new Error(
    'FATAL: OAUTH_ALLOW_MOCK=true is set in a production process. The mock OAuth '
    + 'transport accepts an unsigned identity from the request body and would let '
    + 'anyone sign in as any user. Unset it, and configure real provider credentials.'
  );
}

/**
 * The routing provider's API key, for travel times. Optional.
 *
 * Absent is a supported, silent state rather than an error: `/api/travel-time`
 * answers 503 `routing_unconfigured` and the client renders nothing, leaving the
 * directions link — which needs no provider — exactly as it was. A pilot that
 * has not signed up for OpenRouteService loses a rough number and nothing else.
 *
 * It lives here and never reaches the browser. A key shipped to a browser is a
 * published key, and that is the entire reason `/api/travel-time` is a server
 * route instead of a fetch from the page.
 */
export const ROUTING_API_KEY = process.env.ROUTING_API_KEY || '';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
export const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';

/**
 * Which Microsoft directory may sign in.
 *
 * `common` — the default — accepts any Entra ID tenant and personal Microsoft
 * accounts. That is right for a district that has not decided yet, and wrong for
 * one that has: with `common`, anybody on the internet with any Microsoft account
 * can complete the flow, and the only thing standing between them and an account
 * here is the email-verification step (which a Microsoft sign-up still requires,
 * because Graph's `mail` carries no proof of control — see providers/microsoft.js).
 *
 * Set it to the district's tenant GUID to refuse every other directory at the
 * provider, before a token is ever minted. `providers/microsoft.js` additionally
 * checks the `tid` claim against this value, so a tenant restriction cannot be
 * bypassed by pointing the flow at a different authorize URL.
 */
export const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'common';
export const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:5173/oauth/callback';

/**
 * Where the provider sends the user back — validated in production.
 *
 * The default above is right for development and catastrophic in production,
 * and it applies silently. Verified during the pre-pilot review: with real
 * Google credentials set and OAUTH_REDIRECT_URI forgotten, the server booted
 * without complaint, reported `{"id":"google","enabled":true}` so the "Continue
 * with Google" button rendered for everyone, and minted authorize URLs carrying
 * `redirect_uri=http://localhost:5173/oauth/callback`.
 *
 * Every student pressing that button then gets one of two outcomes. If
 * localhost is not a registered URI on the OAuth client, Google refuses with
 * `redirect_uri_mismatch` — a dead end on a sign-in path the app advertises. If
 * it IS still registered — the common case, because it is what development uses
 * and the same client tends to get reused — Google hands a live authorization
 * code to `http://localhost:5173` over plain HTTP on the user's own machine.
 *
 * Forgetting it is a likely mistake, not an exotic one: it is not listed in
 * deploy/wevolunteer.env.example, so an operator following the runbook has no
 * reason to know it exists.
 *
 * Everything else in this file fails CLOSED on this class of mistake — a
 * placeholder JWT_SECRET and OAUTH_ALLOW_MOCK in production both refuse to boot.
 * This did not, so it now does.
 *
 * Only enforced when a provider is actually configured: an email-only district
 * is a normal deployment and must not be made to set a variable for a feature it
 * does not use.
 */
const ANY_OAUTH_PROVIDER_CONFIGURED =
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  || Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);

if (IS_PRODUCTION && ANY_OAUTH_PROVIDER_CONFIGURED) {
  let host = null;
  try {
    host = new URL(OAUTH_REDIRECT_URI).hostname;
  } catch {
    throw new Error(
      `FATAL: OAUTH_REDIRECT_URI is not a valid URL: ${OAUTH_REDIRECT_URI}\n`
      + 'It must be the absolute callback URL of this deployment, e.g.\n'
      + '  OAUTH_REDIRECT_URI=https://volunteers.example.org/oauth/callback'
    );
  }

  // Bracketed IPv6 comes back from URL as "[::1]" on some runtimes and "::1" on
  // others, so both spellings are checked.
  const isLoopback = host === 'localhost' || host === '127.0.0.1'
    || host === '::1' || host === '[::1]';

  if (isLoopback) {
    throw new Error(
      'FATAL: an OAuth provider is configured but OAUTH_REDIRECT_URI still points at '
      + `localhost (${OAUTH_REDIRECT_URI}).\n`
      + 'This is the development default. In production it sends every user who presses\n'
      + '"Continue with Google" to their own machine — and if localhost is still a\n'
      + 'registered redirect URI on the OAuth client, it delivers a live authorization\n'
      + 'code there over plain HTTP.\n'
      + 'Set it to this deployment\'s callback URL, e.g.\n'
      + '  OAUTH_REDIRECT_URI=https://volunteers.example.org/oauth/callback\n'
      + 'and register exactly that value with the provider. To run email-only instead,\n'
      + 'unset GOOGLE_CLIENT_ID/SECRET and MICROSOFT_CLIENT_ID/SECRET.'
    );
  }

  // Not fatal: the provider is the authority here and will reject it, so a hard
  // stop would be us guessing. A loud warning is proportionate — unlike the
  // loopback case, this one fails visibly at the provider rather than silently.
  if (!OAUTH_REDIRECT_URI.startsWith('https://')) {
    console.warn(
      `[config] WARNING: OAUTH_REDIRECT_URI is not https (${OAUTH_REDIRECT_URI}).\n`
      + '         Google and Microsoft both refuse non-HTTPS redirect URIs outside\n'
      + '         localhost, so provider sign-in will fail at the provider.'
    );
  }
}

/**
 * Whether this server will PROCESS a provider — the gate `resolveProvider` uses
 * on the callback. The mock transport counts, because an explicit
 * OAUTH_ALLOW_MOCK opt-in is how the test suite drives a full callback without
 * real credentials. Unconfigured is a normal state (a district may run
 * email-only), not an error.
 */
export const OAUTH_PROVIDERS_ENABLED = {
  google: OAUTH_ALLOW_MOCK || Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  microsoft: OAUTH_ALLOW_MOCK || Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET),
  // Apple has no implementation behind it — see oauth/providers/apple.js.
  apple: false
};

/**
 * Whether a PERSON WITH A BROWSER can complete the flow — which is a different
 * question, and the one the sign-in buttons must be driven by.
 *
 * The mock is a callback-side transport: `verifyCallback` reads its identity out
 * of the `code` parameter. `getAuthUrl` has no mock branch in either provider, so
 * the redirect that starts the flow always goes to the real provider. A mock
 * opt-in therefore does nothing whatsoever for someone pressing a button.
 *
 * Conflating the two made OAUTH_ALLOW_MOCK advertise every provider, and since
 * it defaults to `!IS_PRODUCTION` that is every development environment. The
 * Microsoft button rendered with MICROSOFT_CLIENT_ID unset, and pressing it
 * redirected to login.microsoftonline.com with `client_id=`, which Microsoft
 * rejects:
 *
 *     AADSTS900144: The request body must contain the following parameter:
 *     'client_id'
 *
 * Credentials only, no mock: if the button cannot reach a provider that will
 * accept it, it is not an option we may offer. In production OAUTH_ALLOW_MOCK is
 * off (and refuses to boot), so this and the map above agree there.
 */
export const OAUTH_PROVIDERS_CONFIGURED = {
  google: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
  microsoft: Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET),
  apple: false
};

// Removed as dead exports: SCHOOL_NAME, MAX_AUTO_SELECT_APPLICANTS and
// DEFAULT_EMAIL_FROM were declared here but imported nowhere. The first two
// were actively misleading — MAX_AUTO_SELECT_APPLICANTS reads like a cap on
// the Auto Select pool and enforced nothing. The client keeps its own
// SCHOOL_NAME in src/config.js, which IS used; email.js keeps its own
// EMAIL_FROM. Nothing here changes behaviour.

/**
 * Cross-origin callers permitted to reach /api with credentials.
 *
 * The development default is NOT applied in production.
 *
 * It used to be unconditional, so a production process started without
 * CORS_ORIGINS granted `http://localhost:5173` and `http://localhost:4173`
 * standing permission to make credentialed cross-origin calls and read the
 * replies. Anything the user happened to be running on those ports — any dev
 * server, any local tool — could therefore act as them against the live API,
 * on a deployment whose operator never configured CORS at all.
 *
 * Empty in production is the safe default rather than a broken one: app.js
 * admits same-origin requests by comparing Origin to the request's own Host,
 * and the single-origin topology (this process serving both the SPA and the
 * API) is the documented one. So a deployment that needs no cross-origin
 * caller needs no CORS_ORIGINS, and one that does states it explicitly.
 */
const CORS_ORIGINS_RAW = process.env.CORS_ORIGINS
  ?? (IS_PRODUCTION ? '' : 'http://localhost:5173,http://localhost:4173');

export const ALLOWED_ORIGINS = CORS_ORIGINS_RAW
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

/**
 * A loopback origin in a production allowlist is refused, not ignored.
 *
 * Silently dropping it would leave the operator believing a configured origin
 * is in force. This is the same judgement as OAUTH_REDIRECT_URI above: the
 * development value surviving into production is a misconfiguration worth
 * stopping for, and the message names the fix.
 */
if (IS_PRODUCTION) {
  const loopback = ALLOWED_ORIGINS.filter((origin) => {
    let host;
    try { ({ hostname: host } = new URL(origin)); } catch { return false; }
    return host === 'localhost' || host === '127.0.0.1'
      || host === '::1' || host === '[::1]';
  });

  if (loopback.length > 0) {
    throw new Error(
      `FATAL: CORS_ORIGINS allows a loopback origin in production (${loopback.join(', ')}).\n`
      + 'That grants anything running on the operator\'s or a user\'s own machine\n'
      + 'credentialed cross-origin access to the live API. Set it to this\n'
      + 'deployment\'s public origin, e.g.\n'
      + '  CORS_ORIGINS=https://volunteers.example.org\n'
      + 'or leave it unset entirely if the SPA and the API share one origin —\n'
      + 'same-origin requests are admitted without it.'
    );
  }
}

/**
 * Whether a new account must confirm its email address before using the app.
 *
 * ON by default, inverted from the previous behaviour.
 *
 * It used to default off, and the anti-lockout reasoning for that ("turning it
 * on without a working SMTP transport locks every user out") no longer holds:
 * email.js refuses to boot a production process that has no SMTP transport,
 * and in development the mock transport prints the link to the console, so
 * there is no configuration in which the flag is on and confirmation is
 * impossible.
 *
 * Meanwhile the cost of the old default was severe and invisible. Nothing in
 * the login path ever consulted `email_verified`, so an unconfirmed account
 * could sign in and call every endpoint; only the SPA refused to render, and
 * the SPA is not a security boundary. On a platform holding minors' records
 * that means anyone able to type an address they do not own — a student using
 * a teacher's address, say — got a working account.
 *
 * Set REQUIRE_EMAIL_VERIFICATION=false to opt out deliberately.
 */
export const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';

/**
 * Turning it off in production is legitimate but must not be silent.
 *
 * A warning rather than a refusal, because the flag is a documented opt-out and
 * refusing it would overrule a deployment that meant it — the same line
 * OAUTH_REDIRECT_URI draws when the provider, not this process, is the
 * authority. But nothing else reports it: with the gate off, sign-in never
 * consults `email_verified`, so an account registered against an address its
 * holder does not own works completely, and the only trace is a line in an env
 * file nobody re-reads. On a platform holding minors' records that is worth one
 * line at boot.
 */
if (IS_PRODUCTION && !REQUIRE_EMAIL_VERIFICATION) {
  console.warn(
    '[config] WARNING: REQUIRE_EMAIL_VERIFICATION=false in production.\n'
    + '         Accounts can be used without confirming the address, so anyone\n'
    + '         able to type an address they do not own gets a working account.\n'
    + '         Unset the variable to restore the default (verification required).'
  );
}

// Paths an authenticated-but-unverified user may still reach when
// REQUIRE_EMAIL_VERIFICATION is on: enough to see their own account and finish
// verifying. Deliberately minimal — no action routes, no other users' data.
export const EMAIL_GATE_ALLOWLIST = [
  '/api/auth/me',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  // Signing out and deleting an unconfirmed account must always be possible —
  // otherwise a typo in an address creates an account its owner can neither
  // use nor get rid of.
  '/api/auth/logout',
  '/api/auth/account',
  '/api/notifications',
  /**
   * Correcting a mistyped address is the whole point of the gate being
   * escapable, so these are load-bearing rather than a convenience.
   *
   * The account most likely to be sitting behind this gate is one whose address
   * has a typo in it — which is precisely the account that can never confirm,
   * and therefore never reach anything not on this list. Leaving the
   * email-change routes off it would mean the only way out stayed "abandon the
   * account", and an abandoned account holds its email and username forever.
   *
   * `confirm-email-change` is unauthenticated and so never reaches this check;
   * it is listed for completeness of the flow it belongs to.
   */
  '/api/auth/change-email',
  '/api/auth/cancel-email-change',
  '/api/auth/pending-email-change'
];

/**
 * Allowlisted path PREFIXES, for routes whose path carries a parameter.
 *
 * ── Why this exists (v1.2b Task 6) ──
 *
 * `/api/auth/change-email` and `DELETE /api/auth/account` are on the list above
 * because an account whose address has a typo in it can reach nothing else, and
 * correcting or abandoning it has to stay possible. Task 6 put both of those
 * endpoints behind `requireAAL2`, which means they can no longer be reached
 * without first opening and satisfying a challenge — so leaving the step-up
 * routes outside the gate would have re-closed the only two doors the gate is
 * deliberately escapable through, for exactly the account that needs them.
 *
 * A prefix rather than four exact entries because `GET /api/auth/reauth/oauth/
 * :provider` has a parameter in its path and `EMAIL_GATE_ALLOWLIST.includes()`
 * is an exact match. That route is not optional: a Microsoft-provider account
 * arrives with `email_verified = 0` (Graph attests nothing) and has no password,
 * so provider re-consent is its ONLY way to satisfy a challenge.
 *
 * Widening this to the whole `/api/auth/reauth/` subtree is deliberate and
 * bounded. Every route under it mints assurance for the caller's own account and
 * performs no sensitive action itself; the actions a grant unlocks are gated
 * individually, and the three that are not on the allowlist above
 * (change-password, oauth/link, privacy/export) stay behind the gate exactly as
 * before. So an unconfirmed account gains the ability to prove who it is, and
 * nothing else.
 */
export const EMAIL_GATE_ALLOWLIST_PREFIXES = [
  '/api/auth/reauth/'
];

/** Whether an unconfirmed account may reach this path. */
export function isEmailGateAllowed(path) {
  return EMAIL_GATE_ALLOWLIST.includes(path)
    || EMAIL_GATE_ALLOWLIST_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * Session cookie.
 *
 * Replaces the v1.0 scheme of a JWT in localStorage sent as an Authorization
 * header. The token itself is unchanged — same claims, same 7-day expiry, same
 * signing secret. Only the transport moved, into a place script cannot read.
 */
export const COOKIE_NAME = 'wev_session';

/** Must match the JWT's `expiresIn: '7d'` — a cookie that outlives its token
 *  produces a confusing 403 on a session the browser still believes in. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Options for the session cookie.
 *
 * `sameSite: 'lax'` and NO CSRF token, deliberately.
 *
 * Cookies reintroduce CSRF, which an Authorization header is structurally
 * immune to — so this is only an upgrade if that exposure is actually closed.
 * It is, by the topology: production serves the SPA and the API from one
 * Express process (app.js), and development proxies /api through Vite, so the
 * browser sees a single origin in both. `Lax` blocks cross-site POST, PATCH and
 * DELETE, which is the entire CSRF surface available here.
 *
 * A double-submit token would add nothing against that threat model — it
 * defends against a same-site attacker on a sibling subdomain, which this
 * deployment does not have. Adding one now would be unjustified complexity.
 *
 * REVISIT THIS if the app is ever served from a subdomain alongside another
 * application, or if the API moves to a different origin from the SPA. Either
 * change invalidates the reasoning above and makes a CSRF token necessary.
 *
 * `secure` is gated on production because development runs over plain HTTP
 * through the Vite proxy; a Secure cookie is silently dropped there, which
 * presents as "login succeeds but every subsequent request is 401" — a failure
 * with no visible cause.
 */
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: SEVEN_DAYS_MS,
    path: '/'
  };
}

/**
 * Options for DELETING the session cookie.
 *
 * Deliberately not `cookieOptions()`. Express's `res.clearCookie` merges the
 * options it is given over its own `expires: new Date(1)`, and `res.cookie`
 * then recomputes `expires` from `maxAge` whenever `maxAge` is present — so
 * passing the full options through sets the cookie to expire in seven days
 * instead of clearing it. The attributes that matter for deletion are the ones
 * the browser matches on (name, path, domain); the rest must not carry a
 * lifetime.
 */
export function clearCookieOptions() {
  const { maxAge: _drop, ...rest } = cookieOptions();
  return rest;
}
