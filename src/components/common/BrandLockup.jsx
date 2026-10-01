import React from 'react';
import BrandMark from './BrandMark';
import { APP_NAME } from '../../config';

/**
 * The WeVolunteer lockup: the green tile carrying the checkmark-W, then the
 * name, set as text.
 *
 * The owner's words for it: "green background white W with checkmark … there
 * should be green box with small logo and the white text should be the name"
 * (P2-47), and "a logo should be the same" everywhere (FX-20). The shell had it
 * since 2026-09-27; the error pages, /verify and a club's public page still
 * drew the older wordmark alone (N10). One component now, so a surface cannot
 * keep an old logo after the rest change — the error screens, which nobody
 * opens on purpose, are the ones that get forgotten.
 *
 * The tile is decorative here and the name is the text, so the lockup is named
 * once, by the word a reader can see.
 *
 * @param {object} [props]
 * @param {string} [props.sub]  a second line under the name (the shell's school)
 */
export default function BrandLockup({ sub }) {
  return (
    <>
      <BrandMark />
      <span className="brand-text">
        <span className="brand-name">{APP_NAME}</span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </>
  );
}
