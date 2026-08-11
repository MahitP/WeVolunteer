import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CheckCircle2, AlertCircle, CameraOff } from 'lucide-react';
import Modal, { ModalHead } from './Modal';
import { api } from '../utils/api';

/**
 * The organizer's camera scanner.
 *
 * ── Layering, which is a hard requirement and not a detail ──
 *
 * This renders through `Modal`, whose overlay sits above the mobile navigation
 * by construction. It sets NO z-index of its own — a bespoke value here is
 * exactly how this regresses, and rendering the camera inline inside
 * `CheckInView` would put it UNDER the bottom navigation on every phone.
 *
 * Sizes use `dvh`, never `vh`. Mobile browser chrome collapses and expands, and
 * `100vh` on iOS Safari is taller than the visible viewport — which pushes the
 * close button off the bottom of the screen, on the device this feature is
 * mostly used on.
 *
 * Controls are laid out above and below the preview rather than over it, so the
 * video can never occlude the close button, the manual fallback or the result.
 *
 * ── Decoding ──
 *
 * `BarcodeDetector` where the browser has it (Chrome, Android), lazily-imported
 * jsQR everywhere else — which is to say on every iPhone, since Safari still
 * does not ship the native API and organizers at a venue are mostly holding
 * iPhones. The import is dynamic so nothing is downloaded until somebody
 * actually opens the scanner.
 *
 * The loop is throttled and refuses to submit the same decoded string twice in
 * a row. That is the real defence against a runaway scanner; the server's rate
 * limit is the backstop for when this is bypassed.
 */

/** Decode attempts per second. Faster buys nothing and heats the phone. */
const SCAN_INTERVAL_MS = 100;

/** How long a result stays on screen before scanning resumes. */
const RESULT_HOLD_MS = 2000;

export default function CheckInScanner({ eventId, onClose, onCheckedIn }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const jsQrRef = useRef(null);
  const loopRef = useRef(null);
  const lastTokenRef = useRef(null);
  const busyRef = useRef(false);

  const [cameraError, setCameraError] = useState(null);
  const [result, setResult] = useState(null);

  /** Stops the camera. Called on unmount, on close, and on any hard failure. */
  const stopCamera = useCallback(() => {
    if (loopRef.current) {
      clearInterval(loopRef.current);
      loopRef.current = null;
    }
    if (streamRef.current) {
      /* Every track, explicitly. A MediaStream left running keeps the camera
         light on, which reads to a volunteer as being filmed. */
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  const submit = useCallback(async (token) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await api.scanCheckinCode(eventId, token);
      setResult({
        ok: true,
        alreadyPresent: res.alreadyPresent,
        name: res.volunteer?.name || 'Volunteer',
        slot: res.slot?.name,
      });
      onCheckedIn?.(res);
    } catch (err) {
      setResult({ ok: false, message: err.message || 'That code did not work.' });
    } finally {
      setTimeout(() => {
        busyRef.current = false;
        /* Cleared so the same phone can be rescanned deliberately after a
           refresh, while a camera still pointed at one code does not resubmit
           it forty times a second. */
        lastTokenRef.current = null;
        setResult(null);
      }, RESULT_HOLD_MS);
    }
  }, [eventId, onCheckedIn]);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError(
          window.isSecureContext === false
            ? 'The camera needs a secure connection. Use manual check-in instead.'
            : 'This browser cannot open the camera. Use manual check-in instead.',
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        /* Every one of these ends in the same advice, because the volunteer is
           standing there either way and the roster always works. */
        const message = {
          NotAllowedError: 'Camera access was denied. Use manual check-in instead.',
          NotFoundError: 'No camera on this device. Use manual check-in instead.',
          NotReadableError: 'The camera is being used by another app. Use manual check-in instead.',
          OverconstrainedError: 'No suitable camera found. Use manual check-in instead.',
        }[err?.name] || 'Camera unavailable. Use manual check-in instead.';
        if (!cancelled) setCameraError(message);
        return;
      }

      if (typeof window.BarcodeDetector === 'function') {
        try {
          detectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch { detectorRef.current = null; }
      }
      if (!detectorRef.current) {
        /* Dynamic, so no phone downloads a decoder it will never run. */
        jsQrRef.current = (await import('jsqr')).default;
      }
      if (cancelled) return;

      loopRef.current = setInterval(tick, SCAN_INTERVAL_MS);
    }

    async function tick() {
      const video = videoRef.current;
      if (!video || video.readyState !== 4 || busyRef.current) return;

      let token = null;
      try {
        if (detectorRef.current) {
          const codes = await detectorRef.current.detect(video);
          token = codes?.[0]?.rawValue ?? null;
        } else if (jsQrRef.current) {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const width = video.videoWidth;
          const height = video.videoHeight;
          if (!width || !height) return;
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(video, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height);
          token = jsQrRef.current(image.data, width, height)?.data ?? null;
        }
      } catch {
        /* A frame that fails to decode is the normal case, not an error. */
        return;
      }

      if (!token || token === lastTokenRef.current) return;
      lastTokenRef.current = token;
      submit(token);
    }

    start();
    return () => { cancelled = true; stopCamera(); };
  }, [stopCamera, submit]);

  const close = () => { stopCamera(); onClose(); };

  return (
    <Modal onClose={close} label="Scan a volunteer's check-in code">
      <ModalHead
        title="Scan QR"
        description="Point the camera at a volunteer's code."
        onClose={close}
      />

      <div className="modal-body scanner">
        {/* On the dialog, not inside the result branch that unmounts — so the
            outcome is still announced as the card that showed it disappears. */}
        <span className="sr-only" role="status" aria-live="polite">
          {result
            ? (result.ok
              ? `${result.name} ${result.alreadyPresent ? 'was already checked in' : 'checked in'}`
              : result.message)
            : ''}
        </span>

        {cameraError ? (
          <div className="alert alert-warn scanner-unavailable" role="alert">
            <CameraOff size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span>
              <span className="alert-title">Camera unavailable</span>
              <span style={{ display: 'block', marginTop: 2 }}>{cameraError}</span>
            </span>
          </div>
        ) : (
          <div className="scanner-viewport">
            <video ref={videoRef} className="scanner-video" playsInline muted aria-hidden="true" />
            <canvas ref={canvasRef} className="sr-only" aria-hidden="true" />
          </div>
        )}

        {result && (
          <div className={`scanner-result ${result.ok ? 'is-ok' : 'is-bad'}`}>
            {result.ok ? (
              <>
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>
                  <span className="strong">{result.name}</span>
                  {result.alreadyPresent ? ' was already checked in' : ' checked in'}
                  {result.slot ? ` · ${result.slot}` : ''}
                </span>
              </>
            ) : (
              <>
                <AlertCircle size={18} aria-hidden="true" />
                <span>{result.message}</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="modal-foot scanner-foot">
        {/* The roster is never more than one press away, and is named as an
            equal option rather than as a failure path. */}
        <button type="button" className="btn btn-secondary" onClick={close}>
          Check in by name instead
        </button>
      </div>
    </Modal>
  );
}
