import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext } from "react";
import { vi } from "vitest";

// The shared always-open dropdown-menu mock for the composer posture tests
// (ADR-0099, issue #574). Radix DropdownMenu's pointer-event handling
// recurses under jsdom (known limitation, cf. SessionHeaderMenu.test.tsx),
// so the module is mocked as controlled components: the trigger is a plain
// <button>, and both the menu and every Sub content ALWAYS render -- no
// open/close state -- so second-level rows are directly clickable and the
// tests verify component LOGIC, not Radix's portal internals.
//
// The internal factories are lowercase consts (not PascalCase functions) on
// purpose: react-refresh/only-export-components classifies those as
// components, and this test-infrastructure file is not a refresh boundary.
//
// Consumed via the async-factory form so vi.mock's hoisting stays happy:
//   vi.mock("@/components/ui/dropdown-menu", async () =>
//     (await import("./dropdownMenuMock")).dropdownMenuMockModule);

// The shared onSelect preventDefault spy: every clickable item mock hands
// THIS spy to onSelect instead of a no-op, so tests can assert the keep-open
// contract (e.preventDefault on selection, issue #584) -- the posture
// trigger's only implementation of it, invisible under a no-op placeholder.
// vi.clearAllMocks() in the suites' beforeEach resets it per test.
export const selectPreventDefault = vi.fn();

// The radio group value context: mirrors Radix, where the group's value
// decides each RadioItem's checked state (the mock computes aria-checked the
// same way instead of relying on a per-item prop). Context, not
// cloneElement-injection, because the radio items sit behind the component
// under test's own item wrappers -- only context crosses that boundary.
const radioGroupValueContext = createContext<string>("");

const dropdownMenu = ({ children }: { children: ReactNode }) => (
  <div data-testid="menu-root">{children}</div>
);

const dropdownMenuTrigger = ({
  children,
  asChild,
  ...rest
}: ComponentProps<"button"> & { children: ReactNode; asChild?: boolean }) => {
  // Radix merges its props onto the asChild element; the mock cannot merge,
  // so it renders the child bare (wrapping it in another button would nest
  // <button> in <button>, which jsdom flags and role queries double-count).
  if (asChild) return <>{children}</>;
  return (
    <button type="button" {...rest}>
      {children}
    </button>
  );
};

const dropdownMenuContent = ({ children }: { children: ReactNode }) => (
  <div role="menu">{children}</div>
);

const dropdownMenuItem = ({
  children,
  onSelect,
  disabled,
  ...rest
}: {
  children: ReactNode;
  onSelect?: (e: { preventDefault: () => void }) => void;
  disabled?: boolean;
} & Record<string, unknown>) => (
  <div
    role="menuitem"
    aria-disabled={disabled ?? false}
    onClick={() => {
      if (!disabled) onSelect?.({ preventDefault: selectPreventDefault });
    }}
    {...rest}
  >
    {children}
  </div>
);

const dropdownMenuRadioGroup = ({
  children,
  value,
}: {
  children: ReactNode;
  value?: string;
}) => (
  <radioGroupValueContext.Provider value={value ?? ""}>
    <div role="group">{children}</div>
  </radioGroupValueContext.Provider>
);

const dropdownMenuRadioItem = ({
  children,
  value,
  onSelect,
  disabled,
  ...rest
}: {
  children: ReactNode;
  value: string;
  onSelect?: (e: { preventDefault: () => void }) => void;
  disabled?: boolean;
} & Record<string, unknown>) => {
  // The lowercase factory convention above collides with the hook naming
  // rule; this context read is exactly what the real Radix item does.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const groupValue = useContext(radioGroupValueContext);
  return (
    <div
      role="menuitemradio"
      aria-checked={groupValue === value}
      aria-disabled={disabled ?? false}
      onClick={() => {
        if (!disabled) onSelect?.({ preventDefault: selectPreventDefault });
      }}
      {...rest}
    >
      {children}
    </div>
  );
};

const dropdownMenuSub = ({ children }: { children: ReactNode }) => (
  <div data-testid="menu-sub">{children}</div>
);

const dropdownMenuSubTrigger = ({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) => (
  <div role="menuitem" data-testid="sub-trigger" aria-disabled={disabled ?? false}>
    {children}
  </div>
);

const dropdownMenuSubContent = ({ children }: { children: ReactNode }) => (
  <div data-testid="sub-content">{children}</div>
);

export const dropdownMenuMockModule = {
  DropdownMenu: dropdownMenu,
  DropdownMenuTrigger: dropdownMenuTrigger,
  DropdownMenuContent: dropdownMenuContent,
  DropdownMenuItem: dropdownMenuItem,
  DropdownMenuRadioGroup: dropdownMenuRadioGroup,
  DropdownMenuRadioItem: dropdownMenuRadioItem,
  DropdownMenuSub: dropdownMenuSub,
  DropdownMenuSubTrigger: dropdownMenuSubTrigger,
  DropdownMenuSubContent: dropdownMenuSubContent,
};
