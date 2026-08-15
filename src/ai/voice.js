/**
 * Dictation, and the one honest caveat in this feature.
 *
 * ── This is not on-device, and must never be described as if it were ──
 *
 * Everything else the assistant does runs in the browser. This does not.
 * `SpeechRecognition` is a browser API, not a local one: Chrome and Edge stream
 * the audio to a speech service run by the browser vendor, and the page has no
 * way to observe that, prevent it, or find out what is retained. Safari's
 * behaviour has varied by version.
 *
 * The specification does not require local processing and does not require the
 * implementation to say which it is doing, so there is no property a page can
 * check. That is precisely why this is the one capability that gets its own
 * preference, defaulted off, kept off the main AI switch, and described in the
 * settings copy and the policy as sending audio away.
 *
 * The temptation is to say "voice is processed locally where supported". There
 * is no way to know where it is supported, so that sentence would be a guess
 * presented as a guarantee — on a platform whose users are minors, about their
 * recorded voice.
 *
 * ── Everything below degrades to nothing ──
 *
 * Unsupported browser, denied microphone, no network: the control does not
 * appear or reports plainly that it cannot listen. Typing is always available
 * and is always the primary way in.
 */

/** The vendor-prefixed constructor Chrome and Edge still use. */
function recognitionConstructor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Whether dictation can be offered at all.
 *
 * Presence of the constructor only. It says nothing about where the audio goes,
 * because nothing in the platform does.
 */
export function isVoiceSupported() {
  return recognitionConstructor() !== null;
}

/** A failure with something a person can do about it. */
export class VoiceError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

/**
 * Turn a recogniser error into something worth showing.
 *
 * `not-allowed` is separated because it is the only one with a fix the person
 * controls, and because a denied microphone is a decision to respect rather
 * than a fault to report.
 */
function messageFor(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'WeVolunteer does not have permission to use the microphone. You can allow it in your browser settings, or type instead.';
    case 'no-speech':
      return "I didn't catch anything. Try again, or type instead.";
    case 'audio-capture':
      return 'No microphone was found. You can type instead.';
    case 'network':
      return 'Speech recognition needs a connection and could not reach it. You can type instead.';
    case 'aborted':
      return null;
    default:
      return 'Dictation stopped unexpectedly. You can type instead.';
  }
}

/**
 * Listen once and return what was said.
 *
 * Resolves with the transcript, or with an empty string if nothing was heard.
 * Rejects with a VoiceError carrying a message already fit to show.
 *
 * `stop()` on the returned handle ends the session and resolves with whatever
 * was recognised so far — a person pressing stop mid-sentence should keep their
 * words, not lose them.
 */
export function startDictation({ onInterim, lang } = {}) {
  const Ctor = recognitionConstructor();
  if (!Ctor) {
    return {
      stop: () => {},
      result: Promise.reject(new VoiceError('This browser cannot do dictation.', { code: 'unsupported' })),
    };
  }

  const recognition = new Ctor();
  /* One utterance, not an open microphone. A control that keeps listening until
     it is told otherwise is a recording device, and this is a dictation box. */
  recognition.continuous = false;
  recognition.interimResults = Boolean(onInterim);
  recognition.maxAlternatives = 1;
  if (lang) recognition.lang = lang;

  let finalText = '';
  let settled = false;

  const result = new Promise((resolve, reject) => {
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const alt = event.results[i][0];
        if (event.results[i].isFinal) finalText += alt.transcript;
        else interim += alt.transcript;
      }
      if (interim && onInterim) onInterim(interim);
    };

    recognition.onerror = (event) => {
      if (settled) return;
      const message = messageFor(event.error);
      settled = true;
      /* An abort is the person pressing stop, so it resolves with what was
         heard rather than rejecting. */
      if (message === null) resolve(finalText.trim());
      else reject(new VoiceError(message, { code: event.error }));
    };

    recognition.onend = () => {
      if (settled) return;
      settled = true;
      resolve(finalText.trim());
    };
  });

  try {
    recognition.start();
  } catch (err) {
    /* Already running, or refused synchronously. */
    return {
      stop: () => {},
      result: Promise.reject(new VoiceError('Dictation could not start.', { code: 'start_failed', cause: err })),
    };
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        /* Already stopped. */
      }
    },
    result,
  };
}
