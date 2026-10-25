"use client";

import { useEffect, useState } from "react";
import { copyTextToClipboard } from "@/lib/clipboard";

/** Icon button that copies text and shows a check mark for a moment. */
export default function CopyButton({
  getText,
  label,
  className,
}: {
  getText: () => string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? "Copied!" : label}
      title={copied ? "Copied!" : "Copy"}
      onClick={async () => {
        if (await copyTextToClipboard(getText())) setCopied(true);
      }}
    >
      {copied ? (
        // Green check mark
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#22c55e" aria-hidden="true">
          <path d="M9 16.2l-3.5-3.5L4 14.2 9 19l11-11-1.5-1.5z" />
        </svg>
      ) : (
        // A tiny static icon; next/image would add nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/copy.svg" alt="" aria-hidden="true" />
      )}
    </button>
  );
}
