import styles from "../Chat.module.css";
import type { ContextFill } from "@/lib/types";

// As large as the buttons next to it, which are circles of 36px with a border of 1px
const SIZE = 36;
const CENTER = SIZE / 2;
// The circle itself: its outline falls where a button's border does
const OUTLINE = CENTER - 0.5;
// The part of the outline that is filled: a heavier stroke, with its outer edge on the circle's
const STROKE = 3.5;
const ARC = CENTER - STROKE / 2;
const LENGTH = 2 * Math.PI * ARC;

/**
 * How full the model's context window is: a circle the size of the buttons
 * next to it, whose outline fills clockwise from the top, and is filled all
 * the way round where older steps of the conversation are cleared or
 * summarised (see server/chat/budget.ts). An indicator only: it has no text,
 * takes no clicks and no focus, and is left out of what screen readers read.
 */
export default function ContextIndicator({ used, full }: ContextFill) {
  const share = full > 0 ? Math.min(1, Math.max(0, used / full)) : 0;
  return (
    <span className={styles.contextIndicator} aria-hidden="true">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle className={styles.contextCircle} cx={CENTER} cy={CENTER} r={OUTLINE} />
        {/* Nothing for an empty window: a stroke of no length would still show its round ends */}
        {share > 0.005 && (
          <circle
            className={styles.contextArc}
            cx={CENTER}
            cy={CENTER}
            r={ARC}
            strokeWidth={STROKE}
            strokeDasharray={`${(share * LENGTH).toFixed(2)} ${LENGTH.toFixed(2)}`}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        )}
      </svg>
    </span>
  );
}
