import type { ComponentProps, ReactNode } from "react";

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
      if (!disabled) onSelect?.({ preventDefault: () => {} });
    }}
    {...rest}
  >
    {children}
  </div>
);

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
  DropdownMenuSub: dropdownMenuSub,
  DropdownMenuSubTrigger: dropdownMenuSubTrigger,
  DropdownMenuSubContent: dropdownMenuSubContent,
};
