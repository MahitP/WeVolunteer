import React, { useState, useRef, useEffect } from 'react';
import { Sun, Moon, Monitor, SunMoon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

export default function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const handleSelect = (newTheme) => {
    setTheme(newTheme);
    setOpen(false);
  };

  const CurrentIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        className={`btn btn-secondary btn-icon ${open ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label="Theme settings"
      >
        <CurrentIcon size={20} />
      </button>

      {open && (
        <div className="popover menu" role="menu" style={{ top: '100%', right: 0, marginTop: 8, width: 140 }}>
          <div className="menu-item" style={{ padding: '0.5rem', cursor: 'default', background: 'transparent' }} onClick={e => e.stopPropagation()}>
            <div className="segmented" role="radiogroup" aria-label="Theme preference" style={{ width: '100%' }}>
              <button
                role="radio"
                aria-checked={theme === 'light'}
                onClick={() => handleSelect('light')}
                style={{ padding: '0.25rem 0.5rem', flex: 1, display: 'flex', justifyContent: 'center' }}
                title="Light theme"
                aria-label="Light theme"
              >
                <Sun size={15} />
              </button>
              <button
                role="radio"
                aria-checked={theme === 'system'}
                onClick={() => handleSelect('system')}
                style={{ padding: '0.25rem 0.5rem', flex: 1, display: 'flex', justifyContent: 'center' }}
                title="System theme"
                aria-label="System theme"
              >
                <SunMoon size={15} />
              </button>
              <button
                role="radio"
                aria-checked={theme === 'dark'}
                onClick={() => handleSelect('dark')}
                style={{ padding: '0.25rem 0.5rem', flex: 1, display: 'flex', justifyContent: 'center' }}
                title="Dark theme"
                aria-label="Dark theme"
              >
                <Moon size={15} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
