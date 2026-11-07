import styles from "../Chat.module.css";
import { FileIcon, GlobeIcon, SpannerIcon } from "@/components/icons";
import type { ToolIcon } from "@/lib/agentTools";
import type { ToolStep } from "@/lib/types";

/** The icon of a tool step: a globe for the web tools, a file for the file tools, a spanner for the rest. */
export function ToolStepIcon({ icon, className }: { icon: ToolIcon; className?: string }) {
  if (icon === "globe") return <GlobeIcon className={className} />;
  return icon === "file" ? <FileIcon className={className} /> : <SpannerIcon className={className} />;
}

/** One tool call in a reply's trace: what it did, and a screenshot's thumbnail. */
export default function ToolLine({ step }: { step: ToolStep }) {
  return (
    <div className={`${styles.toolStep} ${step.state === "error" ? styles.toolStepFailed : ""}`}>
      <ToolStepIcon icon={step.icon} className={styles.toolIcon} />
      <span className={styles.toolLabel} title={step.label}>
        {step.label}
      </span>
      {step.attachmentId && (
        <a
          className={styles.toolShot}
          href={`/api/attachments/${step.attachmentId}`}
          target="_blank"
          rel="noopener"
          aria-label={`Open the screenshot: ${step.label}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
          <img src={`/api/attachments/${step.attachmentId}`} alt="" loading="lazy" />
        </a>
      )}
    </div>
  );
}
