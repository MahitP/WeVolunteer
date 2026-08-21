import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Cpu } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
import { formatBytes, isDigestVerified } from '../../ai';

/**
 * The dialog somebody reads before several hundred megabytes are downloaded to
 * their device.
 *
 * ── What this screen owes the reader ──
 *
 * It is the only place the trade is stated, so it has to state it accurately
 * rather than favourably. Three things are easy to overclaim here and are
 * deliberately not:
 *
 *  1. "Nothing leaves your device" would be false. Downloading the model is a
 *     request to Hugging Face, which carries this device's IP address to a third
 *     party. That is said plainly, not buried.
 *  2. The environmental point is real but small and conditional, so it is given
 *     as a comparison with a named alternative rather than as "AI that is good
 *     for the planet".
 *  3. Answers about a student's own hours and events still need WeVolunteer's
 *     server. Only the language model runs here.
 *
 * ── The picker ──
 *
 * A model the device cannot survive is not listed at all, so the choice offered
 * is always a choice that works. On iPhone and iPad that usually means one
 * option, and the reason is shown rather than the list silently being short.
 */
export default function AIEnableModal({ capability, models, initialModelId, onConfirm, onClose }) {
  const [selectedId, setSelectedId] = useState(
    initialModelId || models.find(m => m.tier === capability.recommendedTier)?.id || models[0]?.id,
  );

  const selected = models.find(m => m.id === selectedId) || null;

  return (
    <Modal onClose={onClose} label="Set up Welly AI" size="lg">
      <ModalHead
        title="Set up Welly AI"
        description="Welly AI runs private, on-device AI directly on your device. Once downloaded, conversations stay in your browser and can work without an internet connection."
        onClose={onClose}
      />

      <div className="modal-body stack-lg">
        <section className="stack-xs">
          <h3>What it can do</h3>
          <p className="dim small">
            Ask about opportunities, your volunteer history, your certificates and the
            organizations you are part of. It reads the same information you can already
            see in WeVolunteer, and it can suggest — never decide. Hours, certificates and
            who gets a place are decided the same way they always have been.
          </p>
        </section>

        <section className="stack-xs">
          <h3>Where your information goes</h3>
          <p className="dim small">
            Welly runs inside this browser. What you type to it is not sent
            to an AI company, and there is no account or key behind it.
          </p>
          <p className="dim small">
            Two things do use the network, and it is worth being exact about them. Setting
            up downloads the model from <strong>Hugging Face</strong>, which means that
            company receives a request from this device. And questions about your own hours,
            events or certificates are answered from WeVolunteer&rsquo;s server, exactly as
            the rest of the app is.
          </p>
        </section>

        <section className="stack-xs">
          <h3>Energy use</h3>
          <p className="dim small">
            Running the model here uses this device&rsquo;s battery rather than a data
            centre, and once it is downloaded there is no further transfer for each
            question. Whether that is better overall depends on the device, the model and
            how much it is used, so it is a reasonable trade rather than a green claim.
          </p>
        </section>

        <section className="stack-sm">
          <h3>Choose a model</h3>

          {capability.reason && (
            <p className="dim small">{capability.reason}</p>
          )}

          {/* fieldset-plain exists for exactly this: the grouping is for
              assistive technology, and the browser's default border is not
              part of the design system. */}
          <fieldset className="fieldset-plain stack-sm">
            <legend className="sr-only">Choose which model to download</legend>

            {models.map(model => {
              const recommended = model.tier === capability.recommendedTier;
              const descriptionId = `ai-model-desc-${model.id}`;

              return (
                <label key={model.id} className="card card-pad row" htmlFor={`ai-model-${model.id}`}>
                  <input
                    type="radio"
                    id={`ai-model-${model.id}`}
                    name="ai-model"
                    value={model.id}
                    checked={selectedId === model.id}
                    onChange={() => setSelectedId(model.id)}
                    aria-describedby={descriptionId}
                  />
                  <div className="stack-xs" style={{ flex: 1 }}>
                    <span className="strong">
                      {model.label}
                      {/*
                        The recommendation is a word, not only a ring or a
                        colour. A marker that exists solely as a border is
                        invisible to a screen reader and to anyone who cannot
                        distinguish it.
                      */}
                      {recommended && <span className="tag tag-brand" style={{ marginLeft: 'var(--s2)' }}>Recommended</span>}
                    </span>
                    <span className="dim small" id={descriptionId}>
                      {formatBytes(model.bytes)} download &middot; {model.parameters} parameters
                      &middot; {model.license}
                      {!isDigestVerified(model) && ' · checked by size only'}
                    </span>
                  </div>
                </label>
              );
            })}
          </fieldset>

          <p className="dim small">
            The model is stored in this browser and can be removed at any time from this
            screen. Clearing your browsing data removes it too, and it would need
            downloading again.
          </p>
        </section>

        <p className="dim small">
          <Link to="/legal/ai-and-on-device-processing">
            Read the AI and On-Device Processing Policy
          </Link>
        </p>
      </div>

      <div className="modal-foot">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!selected}
          onClick={() => selected && onConfirm(selected)}
        >
          {selected
            ? <>Download {formatBytes(selected.bytes)} and turn on</>
            : 'Turn on'}
        </button>
      </div>
    </Modal>
  );
}

/** Shown when the device cannot run any model, in place of the picker. */
export function AIUnsupportedNotice({ reason }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
      <Cpu size={18} aria-hidden="true" />
      <div className="stack-xs" style={{ flex: 1 }}>
        <span className="strong">Welly AI cannot run on this device</span>
        <span className="dim small">{reason}</span>
        <span className="dim small">
          Welly Chat is still available, and everything else in WeVolunteer works exactly as it does elsewhere.
        </span>
      </div>
    </div>
  );
}

/** A small confirmation row, used after a model finishes downloading. */
export function AIReadyRow({ label }) {
  return (
    <span className="row" style={{ gap: 'var(--s2)' }}>
      <Check size={16} aria-hidden="true" />
      <span className="small">{label} is ready. Welly AI is active on this device.</span>
    </span>
  );
}

