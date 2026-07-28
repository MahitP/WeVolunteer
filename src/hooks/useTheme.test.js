import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useTheme } from './useTheme';

describe('useTheme hook', () => {
  let matchMediaMock;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    
    // Mock window.matchMedia
    matchMediaMock = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    window.matchMedia = matchMediaMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to system theme when no localStorage value exists', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('system');
    // Default system is light in our mock (matches: false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies dark theme if system prefers dark mode', () => {
    matchMediaMock.mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderHook(() => useTheme());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('loads saved theme from localStorage', () => {
    localStorage.setItem('wevol-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('sets new theme, updates DOM, and saves to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    
    act(() => {
      result.current[1]('dark');
    });

    expect(result.current[0]).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('wevol-theme')).toBe('dark');
  });

  it('removes localStorage item when system is selected', () => {
    localStorage.setItem('wevol-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    
    act(() => {
      result.current[1]('system');
    });

    expect(result.current[0]).toBe('system');
    expect(localStorage.getItem('wevol-theme')).toBeNull();
  });
});
