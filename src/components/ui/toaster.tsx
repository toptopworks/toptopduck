import * as ToastPrimitives from "@radix-ui/react-toast";

import { Toast, ToastClose, ToastDescription, ToastIcon, ToastTitle, ToastViewport } from "./toast";
import { useToast } from "./use-toast";

// shadcn radix-toast Toaster (ADR-0142, issue #1494): the shell-root
// viewport mount. App owns the single instance, so the column-top
// placement (main-area column center, see toast.tsx's viewport) is
// constant across panel open/close (ADR-0142 Decision 3) -- consumers
// never mount a Toaster themselves. swipeDirection follows the placement
// (column-top, swipe up to dismiss); duration (5s radix default),
// hover/focus pause, and stacking ride the library defaults (ADR-0142
// Decision 4). Wording-free: the consumer's title/description render
// verbatim, no component-side copy.

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastPrimitives.Provider swipeDirection="up">
      {toasts.map(({ id, title, description, action, variant, ...props }) => (
        <Toast key={id} variant={variant} {...props}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ToastIcon variant={variant} />
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastPrimitives.Provider>
  );
}
