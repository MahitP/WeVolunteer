import React, { useState, useRef, useEffect } from 'react';
import { Check, Moon, Monitor, Sun, SunMoon } from 'lucide-react';
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
  const options = [
    { value: 'light', label: 'Light', description: 'Bright canvas', icon: Sun },
    { value: 'system', label: 'System', description: 'Match device', icon: Monitor },
    { value: 'dark', label: 'Dark', description: 'Dim surfaces', icon: Moon },
  ];

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        className={`btn btn-secondary btn-icon ${open ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label="Theme settings"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CurrentIcon size={20} />
      </button>

      {open && (
        <div className="popover theme-menu" role="menu" style={{ top: '100%', right: 0, marginTop: 8 }}>
          <div role="radiogroup" aria-label="Theme preference" className="stack-xs">
            {options.map(({ value, label, description, icon: Icon }) => (
              <button
                key={value}
                className="theme-menu-option"
                role="radio"
                aria-checked={theme === value}
                onClick={() => handleSelect(value)}
              >
                <span className="theme-menu-option-icon" aria-hidden="true">
                  <Icon size={15} />
                </span>
                <span>
                  <span className="theme-menu-option-label">{label}</span>
                  <span className="theme-menu-option-desc">{description}</span>
                </span>
                <Check className="theme-menu-option-check" size={15} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
