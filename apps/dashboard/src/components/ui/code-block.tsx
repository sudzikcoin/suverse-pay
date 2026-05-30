"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Code block with a built-in Copy button.
 *
 * The button floats top-right, always visible (no hover-reveal) so
 * the affordance is discoverable on touch devices. Click → "Copied ✓"
 * for 1.5 s, then reverts.
 *
 * `value` is the plain text copied to clipboard; `children` is what
 * renders inside the pre/code (so callers can pass JSX with
 * highlighting if they want, while keeping the clipboard payload
 * exact). When `children` is omitted, `value` is rendered verbatim.
 *
 * `tone` controls the surface — "default" is the usual translucent
 * bg, "inline" drops the border for embedded blocks (env list panel
 * is already inside a bordered card).
 */
export interface CodeBlockProps {
  value: string;
  children?: React.ReactNode;
  label?: string;
  tone?: "default" | "inline";
  /** Cap the rendered height; horizontal scroll for the rest. */
  maxHeightClass?: string;
  className?: string;
}

export function CodeBlock({
  value,
  children,
  label,
  tone = "default",
  maxHeightClass,
  className,
}: CodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard blocked (insecure context or denied permission).
        // The text in the <pre> is still selectable for manual copy.
      },
    );
  }

  const preClasses = cn(
    "overflow-auto font-mono text-[12px] leading-relaxed",
    tone === "default"
      ? "rounded-md border border-border bg-background/40 p-4 pr-24"
      : "p-0 pr-24",
    maxHeightClass,
    className,
  );

  return (
    <div className="relative">
      {label ? (
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {label}
        </div>
      ) : null}
      <pre className={preClasses}>
        <code>{children ?? value}</code>
      </pre>
      <Button
        type="button"
        variant={copied ? "accent" : "outline"}
        size="sm"
        onClick={copy}
        aria-label="Copy to clipboard"
        className={cn(
          "absolute right-2 transition-opacity",
          label ? "top-7" : "top-2",
        )}
      >
        {copied ? "Copied ✓" : "Copy"}
      </Button>
    </div>
  );
}
