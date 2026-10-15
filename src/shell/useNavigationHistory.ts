import { createContext, useContext } from "react";

// In-app back/forward navigation history consumer (issue #288). This module is
// the react-refresh-friendly home for the non-component parts of the navigation
// surface: the Context object, the NavigationHistoryValue type, and the
// useNavigationHistory consumer hook. NavigationHistoryProvider (the component
// that owns the stack) lives in NavigationHistoryContext.tsx so a file never
// mixes a component export with a hook/value export (react-refresh). The hook
// throws outside a provider so a missing ancestor fails loudly instead of
// silently no-op'ing the topbar buttons.

export type NavigationHistoryValue = {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
};

export const NavigationHistoryContext = createContext<NavigationHistoryValue | null>(null);

export function useNavigationHistory(): NavigationHistoryValue {
  const value = useContext(NavigationHistoryContext);
  if (value === null) {
    throw new Error("useNavigationHistory must be used within a NavigationHistoryProvider");
  }
  return value;
}
