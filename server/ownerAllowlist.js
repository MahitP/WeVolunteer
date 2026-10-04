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

/**
 * Which of the two owner accounts this is, by its address (FX-09, FX-10).
 *
 * The owner asked for the two to "get different profile pages": his own, which
 * should look like a student's because he is one, and the platform's account.
 * Role cannot tell them apart — both are owners — so identity is the address,
 * the same thing the allowlist above names.
 */
export const FOUNDER_EMAIL = 'mahitp.16@gmail.com';
export const PLATFORM_ACCOUNT_EMAIL = 'wevolunteer.platform@gmail.com';

/** `'founder'`, `'platform'`, or null for any other address. */
export function ownerIdentity(email) {
  const address = String(email ?? '').trim().toLowerCase();
  if (address === FOUNDER_EMAIL) return 'founder';
  if (address === PLATFORM_ACCOUNT_EMAIL) return 'platform';
  return null;
}

/**
 * Handles kept for the owner accounts: "username is @mahit" (FX-09).
 *
 * Nothing guaranteed it — any account could register the handle or rename
 * itself to it. Reserved here, checked at signup (password and OAuth alike),
 * at the availability check and at rename. An account that already holds one
 * is the owner's to resolve; nothing renames or deletes anybody.
 */
export const RESERVED_HANDLES = Object.freeze({
  mahit: FOUNDER_EMAIL,
  wevolunteer: PLATFORM_ACCOUNT_EMAIL,
});

/** True when `username` is reserved for an address other than `email`. */
export function handleReservedAgainst(username, email) {
  const owner = RESERVED_HANDLES[String(username ?? '').trim().toLowerCase()];
  if (!owner) return false;
  return String(email ?? '').trim().toLowerCase() !== owner;
}
