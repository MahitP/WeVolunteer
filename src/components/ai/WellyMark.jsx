import React from 'react';
import { Sparkles } from 'lucide-react';

/**
 * Welly's mark.
 *
 * ── Why it uses the Spark visual language ──
 *
 * Welly shares the same spark visual language used for "Suggested for you"
 * in Discover and distinctions throughout WeVolunteer.
 *
 * Welly wears the brand tile (`BrandMark` tokens `--brand-mark-bg` and
 * `--brand-mark-ink`) so it reads as a native part of WeVolunteer at a glance.
 */
export default function WellyMark({ label, size }) {
  const iconSize = size === 'lg' ? 22 : size === 'sm' ? 14 : 16;
  return (
    <span
      className={size === 'lg' ? 'brand-mark brand-mark-lg welly-mark' : 'brand-mark welly-mark'}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <Sparkles size={iconSize} strokeWidth={2.2} aria-hidden="true" />
    </span>
  );
}
