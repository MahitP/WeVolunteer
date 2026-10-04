import React, { useCallback, useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { isLocalAIEnabled, aiCertificate, createRuntime, modelById, AIStatus } from '../../ai';
import { readPreferences } from '../../ai/preferences';

/**
 * Importing a certificate into the external-hours form.
 *
 * ── What this is not ──
 *
 * It is not an upload. There is no endpoint behind it; the file is read in this
 * tab, parsed here, and dropped. That is why the feature needed no route, no
 * size limit on the API and no storage.
 *
 * It is also not a submission. Everything it finds lands in the form as a
 * draft, marked, and editable. These hours end up in a student's service
 * record, so a document's reading is a suggestion and the person's
 * confirmation is the decision. Nothing here can save anything.
 *
 * ── Why the model is loaded lazily and only sometimes ──
 *
 * A digitally issued PDF is usually read completely by the text layer and a set
 * of patterns, with no model involved. Loading one before knowing whether it is
 * needed would spend several hundred megabytes of memory on most imports for
 * nothing, so it is loaded only when the first pass leaves a gap.
 */
export default function CertificateImport({ onExtracted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState([]);
  const inputRef = useRef(null);
  const runtimeRef = useRef(null);

  /* Released with the component, so a model loaded for one import does not sit
     in memory for the rest of the session. */
  React.useEffect(() => () => { runtimeRef.current?.unload(); }, []);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotes([]);

    try {
      const { readCertificate } = await aiCertificate();

      /**
       * The first pass runs without a model. If it answers everything, no model
       * is ever loaded — which for a typical certificate is the whole story.
       */
      let result = await readCertificate(file, { runtime: null });

      /* `fillable` leaves out the hours for a photo, which is never read for
         them (ruling 20), so their absence does not load a model. */
      const stillMissing = (result.fillable ?? ['organizationName', 'activityName', 'occurredOn', 'hours'])
        .some(key => result.fields[key] === undefined);
      const prefs = readPreferences();

      if (stillMissing && prefs.enabled && prefs.modelId) {
        try {
          if (!runtimeRef.current) {
            const runtime = await createRuntime();
            await runtime.load(modelById(prefs.modelId));
            runtimeRef.current = runtime;
          }
          if (runtimeRef.current.status === AIStatus.READY) {
            result = await readCertificate(file, { runtime: runtimeRef.current });
          }
        } catch {
          /* The first pass already produced whatever it could, and that is
             what gets used. A model that will not start is not a reason to
             discard a good read. */
        }
      }

      setNotes(result.notes || []);
      onExtracted?.(result);
    } catch (err) {
      setError(err?.message || 'That file could not be read.');
    } finally {
      setBusy(false);
      /* Cleared so choosing the same file twice fires a change event. */
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [onExtracted]);

  if (!isLocalAIEnabled()) return null;

  return (
    <div className="card card-pad stack-sm">
      <h3>Import from a certificate</h3>
      <p className="dim small">
        Choose a certificate and WeVolunteer will try to fill in the organization, activity,
        date and hours below. From a photo it fills in everything but the hours, which you
        type yourself. The file is read on this device and is not uploaded. Check everything
        before you save it.
      </p>

      <div>
        <label className="btn btn-secondary" htmlFor="certificate-file">
          <FileUp size={16} aria-hidden="true" />
          {' '}Choose a certificate
        </label>
        <input
          ref={inputRef}
          id="certificate-file"
          className="sr-only"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          disabled={busy}
          onChange={e => handleFile(e.target.files?.[0])}
        />
      </div>

      {busy && (
        <p className="dim small row" style={{ gap: 'var(--s2)' }} role="status">
          <Loader2 size={14} aria-hidden="true" />
          Reading the certificate on this device...
        </p>
      )}

      {error && <p className="alert alert-danger" role="alert">{error}</p>}

      {notes.map((note, i) => (
        <p key={i} className="alert alert-info" role="status">{note}</p>
      ))}
    </div>
  );
}
