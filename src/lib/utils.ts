import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui v4 copy-in helper (ADR-0049). Combines clsx (conditional class
// composition) with tailwind-merge (dedupes conflicting Tailwind utilities,
// last wins) so copy-in components compose a `className` override predictably.
// Every shadcn component will import this once copy-in begins; it is the one
// shared utility the copy-in pipeline depends on. No consumers yet.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
