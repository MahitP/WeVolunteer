import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import ProviderButtons from './ProviderButtons';
import { api } from '../../utils/api';

/**
 * Regression cover for the provider row losing Microsoft.
 *
 * The component split the server's list into two groups and rendered them one
 * after the other:
 *
 *   usable      = providers.filter(p => p.enabled)
 *   unavailable = providers.filter(p => !p.enabled && p.implemented === false)
 *
 * A provider that IS implemented but is NOT configured — which is exactly
 * Microsoft on a deployment with no MICROSOFT_CLIENT_ID — matches neither
 * predicate, so it disappeared entirely. Apple, being `implemented: false`, was
 * caught by the second group and stayed. The row therefore rendered
 * Google → Apple, silently dropping the middle provider, and the reported order
 * was wrong for the same reason.
 *
 * Rendering in two groups also meant a disabled provider always sorted after
 * every enabled one, so the order could not be guaranteed even when all three
 * were present.
 *
 * The order is fixed and explicit now: Google, Microsoft, Apple, always, with
 * each one either usable or shown as unavailable.
 */

const labelsInOrder = () =>
  [...document.querySelectorAll('.auth-providers button')].map(b => b.textContent.trim());

const stateOf = (name) => {
  const btn = [...document.querySelectorAll('.auth-providers button')]
    .find(b => new RegExp(name, 'i').test(b.textContent));
  return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

const mockProviders = (list) =>
  vi.spyOn(api, 'fetchOAuthProviders').mockResolvedValue(list);

/** What the server sends when only Google is configured — the reported state. */
const GOOGLE_ONLY = [
  { id: 'google', label: 'Google', enabled: true, implemented: true, state: 'available' },
  { id: 'microsoft', label: 'Microsoft', enabled: false, implemented: true, state: 'misconfigured' },
  { id: 'apple', label: 'Apple', enabled: false, implemented: false, state: 'coming_soon' }
];

const ALL_CONFIGURED = [
  { id: 'google', label: 'Google', enabled: true, implemented: true },
  { id: 'microsoft', label: 'Microsoft', enabled: true, implemented: true },
  { id: 'apple', label: 'Apple', enabled: false, implemented: false }
];

describe('provider order', () => {
  it('renders Google, Microsoft, Apple in that order when only Google is configured', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(labelsInOrder()).toHaveLength(3));
    expect(labelsInOrder().map(t => t.split(/\s+/)[2] || t)).toBeTruthy();
    const order = labelsInOrder().map(t =>
      /google/i.test(t) ? 'google' : /microsoft/i.test(t) ? 'microsoft' : /apple/i.test(t) ? 'apple' : '?');
    expect(order).toEqual(['google', 'microsoft', 'apple']);
  });

  it('keeps the same order when every provider is configured', async () => {
    mockProviders(ALL_CONFIGURED);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(labelsInOrder()).toHaveLength(3));
    const order = labelsInOrder().map(t =>
      /google/i.test(t) ? 'google' : /microsoft/i.test(t) ? 'microsoft' : 'apple');
    expect(order).toEqual(['google', 'microsoft', 'apple']);
  });

  it('does not reorder when the server happens to send a different order', async () => {
    mockProviders([GOOGLE_ONLY[2], GOOGLE_ONLY[1], GOOGLE_ONLY[0]]);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(labelsInOrder()).toHaveLength(3));
    const order = labelsInOrder().map(t =>
      /google/i.test(t) ? 'google' : /microsoft/i.test(t) ? 'microsoft' : 'apple');
    expect(order).toEqual(['google', 'microsoft', 'apple']);
  });
});

describe('unconfigured providers', () => {
  // The precise reported bug: Microsoft missing while Apple is visible.
  it('shows Microsoft rather than hiding it when it is not configured', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(labelsInOrder()).toHaveLength(3));
    expect(stateOf('microsoft')).not.toBeNull();
  });

  /**
   * Misconfigured and unimplemented are disabled identically and worded
   * differently.
   *
   * They used to share "coming soon". That is what let AADSTS900144 sit
   * unnoticed: a Microsoft button one environment variable away from working
   * announced itself as a roadmap item, so the operator — who sees this same
   * screen — had no signal that their own deployment was incomplete.
   */
  it('says a credential-less Microsoft is not set up, rather than coming soon', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(stateOf('microsoft')).not.toBeNull());
    const ms = stateOf('microsoft');
    expect(ms.disabled).toBe(true);
    expect(ms.text).toMatch(/not set up on this site/i);
    expect(ms.text).not.toMatch(/coming soon/i);
  });

  it('keeps "coming soon" for Apple, which genuinely is not built', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(stateOf('apple')).not.toBeNull());
    const apple = stateOf('apple');
    expect(apple.disabled).toBe(true);
    expect(apple.text).toMatch(/coming soon/i);
  });

  /**
   * A server that predates the `state` field still renders something sane.
   * `/api/oauth/providers` is a public endpoint and a cached bundle can outlive
   * a deploy, so the absent-field path is a real one rather than a hypothetical.
   */
  it('falls back to "coming soon" when the server sends no state field', async () => {
    mockProviders([{ id: 'microsoft', label: 'Microsoft', enabled: false, implemented: true }]);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(stateOf('microsoft')).not.toBeNull());
    expect(stateOf('microsoft').text).toMatch(/coming soon/i);
  });

  it('leaves a configured provider enabled and free of the coming-soon label', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(stateOf('google')).not.toBeNull());
    const g = stateOf('google');
    expect(g.disabled).toBe(false);
    expect(g.text).not.toMatch(/coming soon/i);
  });

  it('enables Microsoft once it is configured', async () => {
    mockProviders(ALL_CONFIGURED);
    render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(stateOf('microsoft')).not.toBeNull());
    const ms = stateOf('microsoft');
    expect(ms.disabled).toBe(false);
    expect(ms.text).not.toMatch(/coming soon/i);
  });

  it('only calls onSelect for a provider that is actually usable', async () => {
    const onSelect = vi.fn();
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={onSelect} />);
    await waitFor(() => expect(stateOf('microsoft')).not.toBeNull());
    const ms = [...document.querySelectorAll('.auth-providers button')]
      .find(b => /microsoft/i.test(b.textContent));
    ms.click();
    expect(onSelect).not.toHaveBeenCalled();
    const g = [...document.querySelectorAll('.auth-providers button')]
      .find(b => /google/i.test(b.textContent));
    g.click();
    expect(onSelect).toHaveBeenCalledWith('google');
  });
});

describe('degraded and loading states', () => {
  it('renders nothing rather than a broken row when the probe fails', async () => {
    vi.spyOn(api, 'fetchOAuthProviders').mockRejectedValue(new Error('offline'));
    const { container } = render(<ProviderButtons onSelect={() => {}} />);
    await waitFor(() => expect(container.querySelector('[aria-hidden="true"]')).toBeNull());
    expect(container.querySelectorAll('.auth-providers button')).toHaveLength(0);
  });

  it('respects showUnavailable=false by hiding every unusable provider', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} showUnavailable={false} />);
    await waitFor(() => expect(labelsInOrder()).toHaveLength(1));
    expect(labelsInOrder()[0]).toMatch(/google/i);
  });

  it('applies the caller label only to usable providers', async () => {
    mockProviders(GOOGLE_ONLY);
    render(<ProviderButtons onSelect={() => {}} labelFor={(l) => `Sign up with ${l}`} />);
    await waitFor(() => expect(stateOf('google')).not.toBeNull());
    expect(stateOf('google').text).toBe('Sign up with Google');
    // An unavailable one keeps its own unavailability wording rather than an
    // invitation to do something it cannot do. Which wording that is depends on
    // WHY it is unavailable and is asserted above; what matters here is only
    // that the caller's label was not applied to it.
    expect(stateOf('microsoft').text).not.toMatch(/sign up with/i);
    expect(stateOf('microsoft').text).toMatch(/not set up on this site/i);
  });

  it('disables usable providers while a request is in flight', async () => {
    mockProviders(ALL_CONFIGURED);
    render(<ProviderButtons onSelect={() => {}} disabled />);
    await waitFor(() => expect(stateOf('google')).not.toBeNull());
    expect(stateOf('google').disabled).toBe(true);
    expect(stateOf('microsoft').disabled).toBe(true);
  });
});
