/**
 * The two jobs Welly does under a grammar rather than in conversation.
 *
 * ── Why these are separate from the conversational prompt ──
 *
 * Different task, different failure mode, and — importantly — a different model
 * requirement. Reading a certificate and proposing tags are schema-constrained:
 * the reply is compiled to a grammar and enforced at the sampler, so it parses
 * whatever the model's prose ability. Measured on the 135M model, extraction is
 * reliable and conversation is not, which is why these two stay available at a
 * tier the chat does not offer.
 *
 * They carry no identity and no personality. Nobody reads their output; it is
 * parsed, validated against the server's own rules, and shown as form fields or
 * chips. A friendly tone here would be tokens spent on something invisible.
 *
 * ── Negative instructions do not work at this size ──
 *
 * The tag prompt asks the model to avoid three words. Measured, it returned two
 * of them five times out of eight. The line stays because it costs almost
 * nothing and helps larger models, but the filter in `tags.js` is what actually
 * removes them. Where a rule can be enforced after the fact, it is.
 */

export const CERTIFICATE_PROMPT = [
  'Extract volunteering details from the certificate text below.',
  'Use only what the text says. If something is not stated, use an empty string for text or 0 for hours.',
  'Format the date as YYYY-MM-DD.',
].join(' ');

export const TAGS_PROMPT = [
  'Suggest short topic tags for this volunteering opportunity.',
  'One or two words each, describing what the work is about.',
  'Do not include the words "volunteer", "volunteering" or "event".',
].join(' ');

/**
 * Wrap untrusted text as labelled data.
 *
 * One helper so every task fences its input the same way. The label and the
 * delimiters are a courtesy to the model — they help it tell instructions from
 * content — and they are explicitly NOT the reason injection fails. Injection
 * fails because nothing the model emits can select a tool, issue a request or
 * change what is rendered.
 */
export function asDataBlock(label, content) {
  return `${label}:\n---\n${content}\n---`;
}
