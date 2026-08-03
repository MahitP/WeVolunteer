import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { DownloadCloud, Clock, AlertTriangle, FileArchive, CheckCircle, Check, XCircle } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import { useStepUp } from '../auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';

export default function DataExportCard({ addToast }) {
  const [status, setStatus] = useState('loading'); // loading, none, pending, processing, completed, failed, expired
  const [job, setJob] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { run, modal: verifyModal } = useStepUp();

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    let intervalId;
    if (status === 'pending' || status === 'processing') {
      intervalId = setInterval(fetchStatus, 3000); // slightly faster polling for better UX while modal is open
    }
    return () => clearInterval(intervalId);
  }, [status]);

  const fetchStatus = async () => {
    try {
      const data = await api.getExportStatus();
      if (data.status === 'none') {
        setStatus('none');
        setJob(null);
      } else {
        setStatus(data.status);
        setJob(data);
      }
    } catch (err) {
      console.error('Failed to fetch export status:', err);
      if (status === 'loading') setStatus('none');
    }
  };

  /**
   * ── Why this asks for verification at all (v1.2b) ──
   *
   * An export is a complete copy of everything the account holds, and this was
   * the one sensitive action with no proof of identity behind it: an
   * authenticated request and a rate limit, nothing more. Deleting the account,
   * changing the password and changing the email address each demanded a
   * credential; the action that copies every record out — for a population that
   * is mostly minors — demanded none, which made it the quietest thing a
   * borrowed session could do.
   *
   * The request is attempted before the dialog appears, deliberately. The server
   * answers "an export is already in progress" before it consumes the grant, and
   * checks assurance before the rate limiter, so a user is never asked to verify
   * for an export that was never going to start.
   */
  const handleRequestExport = async () => {
    setIsSubmitting(true);
    try {
      const res = await run(
        STEP_UP.DATA_EXPORT,
        {},
        headers => api.requestExport(headers)
      );
      if (!res) return;

      addToast('Data export requested. This may take a few minutes.', 'success');
      await fetchStatus();
    } catch (err) {
      addToast(err.message || 'Failed to request export', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * ── Why downloading verifies too (v1.2b audit, F-1) ──
   *
   * Requesting the export was gated and collecting it was not, which protected
   * the archive only while it did not exist. Once the worker finished, the
   * finished copy sat behind nothing but a session for seven days, and
   * `/status` hands its id to any authenticated caller — so the quiet,
   * single-request copy of everything the account holds was still available to
   * a borrowed session. The verification belongs where the data leaves.
   *
   * This was `window.location.href = ...` until now. A top-level navigation
   * cannot send the `X-Reauth-Challenge` header, so the archive is fetched as a
   * blob instead and saved from memory — see `api.downloadExport`.
   *
   * The grant binds `jobId`, so verifying to collect this archive authorises
   * collecting this archive and nothing else.
   */
  const handleDownload = async () => {
    if (!job || job.status !== 'completed') return;
    try {
      const blob = await run(
        STEP_UP.DATA_DOWNLOAD,
        { jobId: job.id },
        headers => api.downloadExport(job.id, headers)
      );
      // `run` resolves null when the person closes the verification dialog.
      if (!blob) return;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wevolunteer-data-export.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      addToast(err.message || 'Could not download your export.', 'error');
      // An archive that expired or was swept while the page was open is no
      // longer downloadable, and the card should stop offering it.
      await fetchStatus();
    }
  };

  const renderModalContent = () => {
    if (status === 'pending' || status === 'processing' || isSubmitting) {
      return (
        <div className="stack-lg">
          <div style={{ textAlign: 'center', marginBottom: 'var(--s2)' }}>
            <div style={{ background: 'var(--brand-tint)', padding: 'var(--s4)', borderRadius: 'var(--r-full)', display: 'inline-block', marginBottom: 'var(--s4)' }}>
              <Clock size={40} color="var(--brand)" className="spin" />
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: '700' }}>Preparing Export...</h2>
            <p className="lead" style={{ marginTop: 'var(--s3)', maxWidth: '400px', margin: 'var(--s3) auto 0' }}>
              Your data is being securely compiled into a ZIP archive.
            </p>
          </div>

          <div className="card" style={{ background: 'var(--surface-2)', padding: 'var(--s5)', borderRadius: 'var(--r-md)' }}>
            <div className="skeleton skeleton-line" style={{ width: '40%', marginBottom: 'var(--s4)' }}></div>
            <div className="stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s4)' }}>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="row" style={{ alignItems: 'center', gap: 'var(--s2)' }}>
                  <div className="skeleton" style={{ width: 16, height: 16, borderRadius: 'var(--r-full)' }}></div>
                  <div className="skeleton skeleton-line" style={{ width: '60%' }}></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (status === 'completed' && job) {
      return (
        <div className="stack-lg" style={{ textAlign: 'center', padding: 'var(--s8) var(--s4)' }}>
          <div style={{ margin: '0 auto', color: 'var(--ok)', background: 'var(--ok-tint)', padding: 'var(--s4)', borderRadius: 'var(--r-full)', display: 'inline-block' }}>
            <CheckCircle size={48} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.25rem', marginBottom: 'var(--s2)' }}>Your export is ready</h2>
            <p className="dim">
              Generated: {new Date(job.created_at).toLocaleDateString()}
            </p>
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--s2)', gap: 'var(--s3)' }}>
            <button className="btn btn-ghost btn-lg" onClick={handleRequestExport} disabled={isSubmitting}>
              {isSubmitting ? 'Requesting...' : 'Request New Export'}
            </button>
            <button className="btn btn-primary btn-lg" onClick={handleDownload} disabled={isSubmitting}>
              <DownloadCloud size={18} /> Download Export
            </button>
          </div>
        </div>
      );
    }

    if (status === 'failed' || status === 'expired') {
      return (
        <div className="stack-lg" style={{ textAlign: 'center', padding: 'var(--s8) var(--s4)' }}>
          <div style={{ margin: '0 auto', color: 'var(--danger)', background: 'var(--danger-tint)', padding: 'var(--s4)', borderRadius: 'var(--r-full)', display: 'inline-block' }}>
            <XCircle size={48} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.25rem', marginBottom: 'var(--s2)' }}>
              {status === 'expired' ? 'Export Expired' : 'Unable to prepare export.'}
            </h2>
            <p className="dim">
              {status === 'expired' ? 'Your previous data export has expired.' : 'Try again.'}
            </p>
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--s2)' }}>
            <button className="btn btn-secondary btn-lg" onClick={() => setStatus('none')}>
              Try again
            </button>
          </div>
        </div>
      );
    }

    // Default "Ready to request" state
    return (
      <div className="stack-lg">
        <div style={{ textAlign: 'center', marginBottom: 'var(--s2)' }}>
          <div style={{ background: 'var(--brand-tint)', padding: 'var(--s4)', borderRadius: 'var(--r-full)', display: 'inline-block', marginBottom: 'var(--s4)' }}>
            <FileArchive size={40} color="var(--brand)" />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: '700' }}>Download Your Data</h2>
          <p className="lead" style={{ marginTop: 'var(--s3)', maxWidth: '400px', margin: 'var(--s3) auto 0' }}>
            Request a copy of the information WeVolunteer stores about you.
          </p>
        </div>

        <div className="card" style={{ background: 'var(--surface-2)', padding: 'var(--s5)', borderRadius: 'var(--r-md)' }}>
          <p className="strong" style={{ marginBottom: 'var(--s3)' }}>Your export may include:</p>
          <div className="stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s3)' }}>
            {[
              'Profile information',
              'Volunteer history',
              'Certificates',
              'Applications',
              'Messages',
              'Notification history'
            ].map((item, i) => (
              <div key={i} className="row" style={{ alignItems: 'center', gap: 'var(--s2)', color: 'var(--ink-2)' }}>
                <Check size={16} color="var(--ok)" /> <span className="small">{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--warn-tint)', padding: 'var(--s4)', borderRadius: 'var(--r-sm)', border: '1px solid var(--warn-border)' }}>
          <p className="small" style={{ color: 'var(--warn-ink)', margin: 0, display: 'flex', gap: 'var(--s2)' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
            <span>
              Your export is prepared securely. You will only be able to access your own information.
            </span>
          </p>
        </div>
        
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s3)', marginTop: 'var(--s4)' }}>
          <button 
            type="button" 
            className="btn btn-ghost btn-lg" 
            onClick={() => setShowModal(false)}
          >
            Cancel
          </button>
          <button 
            type="button" 
            className="btn btn-primary btn-lg"
            onClick={handleRequestExport}
          >
            Request Export
          </button>
        </div>
      </div>
    );
  };

  if (status === 'loading') {
    return (
      <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
        <h3 style={{ marginBottom: 'var(--s4)' }}>Data Export</h3>
        <p className="dim small">Checking export status...</p>
      </div>
    );
  }

  return (
    <>
      <div className="card card-pad" style={{ marginTop: 'var(--s4)' }}>
        <h3 style={{ marginBottom: 'var(--s4)' }}>Your Data</h3>
        <p className="dim small" style={{ marginBottom: 'var(--s4)' }}>
          WeVolunteer stores information needed to provide volunteer coordination services.
          You can request a complete ZIP archive of your profile, volunteer history, certificates, applications, and messages.
        </p>

        <div style={{ background: 'var(--surface-2)', padding: 'var(--s4)', borderRadius: 'var(--r-md)', border: '1px solid var(--rule)' }}>
          <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="stack-xs" style={{ flex: 1, marginRight: 'var(--s4)' }}>
              <span className="strong">Download My Data</span>
              {(status === 'none') && <span className="dim small">Request a new copy of your data.</span>}
              {(status === 'pending' || status === 'processing') && <span className="dim small" style={{ color: 'var(--brand)' }}>Export is being generated...</span>}
              {(status === 'completed') && <span className="dim small" style={{ color: 'var(--ok)' }}>Your data export is ready to download.</span>}
              {(status === 'expired') && <span className="dim small" style={{ color: 'var(--warn-ink)' }}>Your previous export has expired.</span>}
              {(status === 'failed') && <span className="dim small" style={{ color: 'var(--danger)' }}>Your previous export failed.</span>}
            </div>
            
            <button className="btn btn-secondary" onClick={() => setShowModal(true)}>
              {status === 'completed' ? 'View Export' : 'Manage Export'}
            </button>
          </div>
        </div>
      </div>

      {/*
        Goes through the shared Modal shell.

        It used to be a hand-rolled `.modal-overlay` with no dialog behaviour at
        all — no role="dialog", no aria-modal, no Escape, no focus containment,
        no focus restore, no scroll lock — and its close control was a bare "×"
        with no accessible name, so a screen reader announced an unlabelled
        button as the only way out.

        `label` rather than aria-labelledby: the heading inside changes with the
        export state ("Preparing Export…", "Your export is ready", …), so a fixed
        accessible name on the dialog itself is the stable choice.
      */}
      {showModal && (
        <Modal
          onClose={() => setShowModal(false)}
          label="Download your data"
          className="data-export-modal"
        >
          <ModalHead title="Download your data" onClose={() => setShowModal(false)} />
          <div className="modal-body">
            {renderModalContent()}
          </div>
        </Modal>
      )}
      {verifyModal}
    </>
  );
}
