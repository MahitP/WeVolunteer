/**
 * Runtime Node-version check.
 *
 * ── Why this is enforced and not just declared ──
 *
 * The whole persistence layer is `node:sqlite`, which is still marked experimental
 * on v24 — every boot prints "SQLite is an experimental feature and might change at
 * any time". `engines` was `>=24.0.0`, which permits Node 25 and beyond, i.e.
 * exactly the upgrades in which an experimental API is permitted to change.
 *
 * `engines` alone does not protect a deployment:
 *
 *   • npm treats it as advisory — it warns and installs anyway unless
 *     `engine-strict` is set;
 *   • `deploy/wevolunteer.service` runs `/usr/bin/env node`, so whatever is on the
 *     service PATH wins, and its only guard was a comment reading
 *     "Verify before enabling: node --version (must be v24.x)".
 *
 * So `apt upgrade nodejs` on the host silently moves the database layer to a runtime
 * where its API is allowed to differ. That failure would surface as corrupt or
 * missing student service-hour records rather than as a clean error, which is the
 * worst shape a failure can take here.
 *
 * This does NOT make node:sqlite stable — that needs an upstream stability promise
 * or a different driver, neither of which belongs in a release-hardening pass. It
 * makes the supported range explicit and refuses to run outside it.
 */

/** The only Node major this application is tested against. */
export const SUPPORTED_NODE_MAJOR = 24;

/**
 * Evaluates a version string against the supported major.
 *
 * Pure and exported so the decision is testable without spawning processes on
 * runtimes that are not installed.
 *
 * An unparseable string returns ok — refusing to boot because a version could not be
 * parsed would turn this guard into the very outage it exists to prevent, and the
 * `engines` field already covers the ordinary case.
 */
export function checkNodeVersion(version = process.version) {
  const match = /^v?(\d+)\./.exec(String(version));
  if (!match) return { ok: true, message: null };

  const major = Number(match[1]);
  if (major === SUPPORTED_NODE_MAJOR) return { ok: true, message: null };

  const direction = major > SUPPORTED_NODE_MAJOR ? 'newer' : 'older';
  return {
    ok: false,
    message:
      `Node ${version} is ${direction} than the supported major (v${SUPPORTED_NODE_MAJOR}.x).\n`
      + '\n'
      + '  This application stores every record through `node:sqlite`, which Node still\n'
      + '  marks EXPERIMENTAL — its API is explicitly allowed to change between majors.\n'
      + `  Running on v${major} has not been tested and could misread or fail to write\n`
      + '  student attendance, credited hours and certificates.\n'
      + '\n'
      + `  Install Node ${SUPPORTED_NODE_MAJOR}.x system-wide (see .nvmrc for the exact\n`
      + '  version this release was tested on) and restart. The systemd unit resolves\n'
      + '  `node` from the service PATH, so check with:\n'
      + '\n'
      + '    sudo -u wev /usr/bin/env node --version\n'
      + '\n'
      + `  To override deliberately, set WEV_ALLOW_UNSUPPORTED_NODE=true — accepting\n`
      + '  that the data layer is running untested.'
  };
}

/**
 * Applies the check at boot.
 *
 * Fatal by default, because the consequence of getting this wrong is silent data
 * damage rather than a visible error. The escape hatch exists so an operator who has
 * genuinely validated a newer runtime is not blocked, and it is deliberately verbose
 * about what they are accepting.
 */
export function enforceNodeVersion() {
  const result = checkNodeVersion();
  if (result.ok) return;

  if (process.env.WEV_ALLOW_UNSUPPORTED_NODE === 'true') {
    console.warn('[Node] WARNING: running on an unsupported Node major.');
    console.warn(result.message);
    console.warn('[Node] Continuing because WEV_ALLOW_UNSUPPORTED_NODE=true.');
    return;
  }

  console.error(`FATAL: unsupported Node version.\n\n${result.message}`);
  process.exit(1);
}
