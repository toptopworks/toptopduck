import type { ReactNode } from "react";

// Shared a11y fallback for React.lazy Suspense boundaries. Wraps the
// loading label in role=status + aria-busy + sr-only so screen readers
// announce the pending chunk fetch. The <FormattedMessage> (or other
// label) is passed as children to keep formatjs message IDs as
// caller-side literals (formatjs-extract-no-cross-function constraint).
interface LazyFallbackProps {
  className: string;
  children: ReactNode;
}

export function LazyFallback({ className, children }: LazyFallbackProps) {
  return (
    <div className={className} role="status" aria-busy="true">
      <span className="sr-only">{children}</span>
    </div>
  );
}
