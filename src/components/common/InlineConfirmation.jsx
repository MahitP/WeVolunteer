import BrandMark from './BrandMark';
import { useConfirmationBeat } from '../../utils/confirmationBeat';

/**
 * A confirmation shown in place, where the brand's success beat plays once.
 *
 * `docs/features/brand-motion.md` §5 names this as the missing prerequisite
 * for attaching `motion="success"` anywhere: the real confirmations — hours
 * credited, an application accepted, a certificate issued — reached the
 * volunteer only as a toast (which the brand system excludes) or as persistent
 * status text (which would replay the beat on every visit). This element is
 * transition-scoped instead. The first time a confirmation is seen, the mark
 * draws its overreach beside the text; on every later visit the same text is
 * there, static, with no mark at all. See `useConfirmationBeat` for how "first
 * time" is decided.
 *
 * The text is the confirmation; the mark is decoration and hidden from
 * assistive technology, so what a screen reader hears never depends on motion.
 * Under reduced motion `wvMotion.css` rests the beat as the complete mark.
 *
 * `itemKey` null renders the children unchanged and records nothing.
 */
export default function InlineConfirmation({ userId, kind, itemKey, className = '', children }) {
  const play = useConfirmationBeat(userId, kind, itemKey);
  return (
    <span className={`inline-confirm ${className}`.trim()}>
      {play && <BrandMark variant="inline" motion="success" />}
      {children}
    </span>
  );
}
