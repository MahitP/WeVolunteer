import { describe, it, expect } from 'vitest';
import { parseOwnerAllowlist, DEFAULT_PLATFORM_OWNER_EMAILS } from './ownerAllowlist.js';

/**
 * The owner's rule, in his words: "u can't make someone a super admin; it's
 * only us two." These pin how the list is read, because the list is the rule.
 */
describe('the owner allowlist', () => {
  it('defaults to the two owner accounts the owner named', () => {
    expect(parseOwnerAllowlist(undefined)).toEqual(['mahitp.16@gmail.com', 'wevolunteer.platform@gmail.com']);
    expect(DEFAULT_PLATFORM_OWNER_EMAILS).toHaveLength(2);
  });

  it('reads a comma-separated override, trimmed and case-folded', () => {
    expect(parseOwnerAllowlist(' A@Example.org , b@example.org ')).toEqual(['a@example.org', 'b@example.org']);
  });

  it('treats an explicitly empty value as "nobody", never as "anybody"', () => {
    /* An operator who blanks the variable has not asked for an open door. The
       failure mode this guards is a list that evaluates to everyone. */
    expect(parseOwnerAllowlist('')).toEqual([]);
    expect(parseOwnerAllowlist(' , ,')).toEqual([]);
  });

  it('has no wildcard', () => {
    expect(parseOwnerAllowlist('*')).toEqual([]);
    expect(parseOwnerAllowlist('@example.org')).toEqual([]);
  });
});
