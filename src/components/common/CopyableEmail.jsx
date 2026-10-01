import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * An email address as text, with a button that copies it.
 *
 * In place of `mailto:` links, which do nothing at all on a device with no mail
 * app configured — no error, no window — and that is most school laptops and
 * plenty of phones (FX-74). The address stays selectable, the button works
 * everywhere the clipboard does, and the result is announced.
 */
export default function CopyableEmail({ address, className = '' }) {
  const [state, setState] = useState('idle');

  const copy = () => {
    const done = () => setState('copied');
    const failed = () => setState('failed');
    if (!navigator.clipboard?.writeText) { failed(); return; }
    navigator.clipboard.writeText(address).then(done, failed);
  };

  return (
    <span className={`copyable-email ${className}`.trim()}>
      <span className="copyable-email-address">{address}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={copy}
        aria-label={`Copy ${address}`}
      >
        {state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span>{state === 'copied' ? 'Copied' : 'Copy'}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? `${address} copied.` : state === 'failed' ? 'Could not copy — select the address instead.' : ''}
      </span>
    </span>
  );
}
