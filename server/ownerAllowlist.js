/**
 * Who may ever hold ownership of this platform.
 *
 * ── The rule ──
 *
 * The owner's words: "u can't make someone a super admin; it's only us two."
 * Before this module, nothing in the code said so. No server route can create an
 * owner — promotion and invitations only ever grant `admin` — but the two
 * command-line tools that can (`bin/grant-ownership.mjs`,
 * `bin/bootstrap-owners.mjs`) accepted any address they were given. A typo, a
 * pasted address from the wrong line, or a well-meant "temporary" grant would
 * all have produced an owner, and an owner can read everything on a platform
 * whose users are mostly minors.
 *
 * ── Why a list in the environment, with a default ──
 *
 * The default is the two accounts the owner named, so a deployment that never
 * thinks about this is already right. `PLATFORM_OWNER_EMAILS` exists so that a
 * change of owner — which will happen if an entity is formed (Posture B) — is a
 * configuration change made deliberately on the host, not an edit to code.
 *
 * ── Why there is no wildcard, and why empty means nobody ──
 *
 * The failure this guards against is a list that quietly evaluates to everyone.
 * So `*` and domain-only entries match nothing, and an explicitly blank value
 * means no address may be granted ownership — an operator who blanks the
 * variable has not asked for an open door.
 *
 * Deliberately free of imports: the CLIs read it, and reaching `config.js` from
 * a CLI would run the server's boot guards.
 */

export const DEFAULT_PLATFORM_OWNER_EMAILS = Object.freeze([
  'mahitp.16@gmail.com',
  'wevolunteer.platform@gmail.com',
]);

const PLAUSIBLE_ADDRESS = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/;

/** The list, from a raw environment value. `undefined` means "use the default". */
export function parseOwnerAllowlist(raw) {
  if (raw === undefined) return [...DEFAULT_PLATFORM_OWNER_EMAILS];
  return String(raw)
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => PLAUSIBLE_ADDRESS.test(entry));
}

/** The list this process runs under. Read once per call so tests can vary it. */
export function platformOwnerEmails(env = process.env) {
  return parseOwnerAllowlist(env.PLATFORM_OWNER_EMAILS);
}

/** Whether ownership may be granted to this address. */
export function mayHoldOwnership(email, env = process.env) {
  const address = String(email ?? '').trim().toLowerCase();
  return address !== '' && platformOwnerEmails(env).includes(address);
}
