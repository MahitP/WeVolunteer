import { useState, useEffect } from 'react';

export function useTheme() {
  const [theme, setThemeState] = useState(() => {
    return localStorage.getItem('wevol-theme') || 'system';
  });

  useEffect(() => {
    const applyTheme = (val) => {
      const isDark = val === 'dark' || (val === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    };

    applyTheme(theme);

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme('system');
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [theme]);

  const setTheme = (newTheme) => {
    if (newTheme === 'system') {
      localStorage.removeItem('wevol-theme');
    } else {
      localStorage.setItem('wevol-theme', newTheme);
    }
    setThemeState(newTheme);
  };

  return [theme, setTheme];
}
