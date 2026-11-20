import styles from "../Chat.module.css";
import type { ContextFill } from "@/lib/types";

// The ring: about as tall as the paperclip in the attach button next to it
const SIZE = 18;
const CENTER = SIZE / 2;
// A little heavier than the icons' strokes (1.5px), so the share stays easy to read
const STROKE = 1.75;
const RADIUS = CENTER - STROKE / 2;
const LENGTH = 2 * Math.PI * RADIUS;

/**
 * How full the model's context window is: in a circle like the buttons next to
 * it, a ring that fills clockwise from the top, and is filled all the way
 * round where older steps of the conversation are cleared or summarised (see
 * server/chat/budget.ts). An indicator only: it has no text, takes no clicks
 * and no focus, and is left out of what screen readers read.
 */
export default function ContextIndicator({ used, full }: ContextFill) {
  const share = full > 0 ? Math.min(1, Math.max(0, used / full)) : 0;
  return (
    <span className={styles.contextIndicator} aria-hidden="true">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle className={styles.contextTrack} cx={CENTER} cy={CENTER} r={RADIUS} strokeWidth={STROKE} />
        {/* Nothing for an empty window: a stroke of no length would still show its round ends */}
        {share > 0.005 && (
          <circle
            className={styles.contextArc}
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeWidth={STROKE}
            strokeDasharray={`${(share * LENGTH).toFixed(2)} ${LENGTH.toFixed(2)}`}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
          />
        )}
      </svg>
    </span>
  );
}
