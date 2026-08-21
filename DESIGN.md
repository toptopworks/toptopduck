---
version: alpha
name: toptopduck
description: A local-first AI data analysis workbench for desktop (Tauri + React). Teal (#0d9488) is the sole brand accent on a dual-mode canvas — clean white in light mode, a dark surface (#0f1410) in dark mode with a subtle green undertone. Compact 6px base radius and 4px spacing signal developer-tool ergonomics. The system font stack carries all UI text; the system monospace stack renders SQL, data, and code. The structural signature is a three-column shell (session sidebar + conversation rail + workspace) with independently collapsible panels. No decorative gradients — depth comes from surface brightness steps, hairline borders, and a 3-tier functional shadow scale (shadow-sm for in-content cards, shadow-md for popovers, shadow-lg for dialogs).

colors:
  # --- Brand (mode-invariant) ---
  primary: "#0d9488"
  primary-foreground: "#ffffff"

  # --- Light surfaces ---
  canvas: "#ffffff"
  ink: "#1a1a1a"
  card: "#ffffff"
  popover: "#ffffff"
  secondary: "#f1f5f4"
  secondary-foreground: "#1a1a1a"
  muted: "#f0f0f3"
  muted-foreground: "#6b7280"
  accent: "#e6f4f1"
  accent-foreground: "#0d9488"
  destructive: "#b00020"
  destructive-foreground: "#ffffff"
  warning: "#b45309"
  border: "#e3e3e8"

  # --- Dark surfaces ---
  canvas-dark: "#0f1410"
  ink-dark: "#e8eae8"
  card-dark: "#181b18"
  popover-dark: "#181b18"
  secondary-dark: "#232723"
  secondary-foreground-dark: "#e8eae8"
  muted-dark: "#232723"
  muted-foreground-dark: "#9ca3af"
  accent-dark: "#143833"
  accent-foreground-dark: "#5eead4"
  destructive-dark: "#ef4444"
  warning-dark: "#f59e0b"
  border-dark: "#2a2f2a"

typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.3px
  headline-lg:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.2px
  headline-md:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  headline-sm:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  body-md:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  label-caps:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.05em
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  button:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: 0
  badge:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: 0
  nav-link:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0

rounded:
  none: 0px
  xs: 4px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 10px
  pill: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  base: 16px
  md: 20px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 64px

components:
  # --- App shell (light) ---
  app-shell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  topbar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    height: 40px
  sidebar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.nav-link}"
    width: 220px

  # --- App shell (dark) ---
  app-shell-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.ink-dark}"
  topbar-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.ink-dark}"
    height: 40px
  sidebar-dark:
    backgroundColor: "{colors.canvas-dark}"
    textColor: "{colors.ink-dark}"
    typography: "{typography.nav-link}"
    width: 220px

  # --- Conversation rail + workspace ---
  conversation-rail:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    width: 320px
  conversation-rail-dark:
    backgroundColor: "{colors.card-dark}"
    textColor: "{colors.ink-dark}"

  # --- Cards ---
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  card-dark:
    backgroundColor: "{colors.card-dark}"
    textColor: "{colors.ink-dark}"

  # --- Popover / Dialog ---
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 24px
  popover-dark:
    backgroundColor: "{colors.popover-dark}"
    textColor: "{colors.ink-dark}"

  # --- Buttons ---
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 16px
    height: 36px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 16px
    height: 36px
  button-secondary-dark:
    backgroundColor: "{colors.secondary-dark}"
    textColor: "{colors.secondary-foreground-dark}"
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 7px 15px
    height: 36px
  button-outline-dark:
    backgroundColor: transparent
    textColor: "{colors.ink-dark}"

  # --- Inputs ---
  text-input:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 8px 12px
    height: 36px
  text-input-dark:
    backgroundColor: transparent
    textColor: "{colors.ink-dark}"

  # --- Badges ---
  badge-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.badge}"
    rounded: "{rounded.md}"
    padding: 2px 8px
  badge-secondary:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.badge}"
    rounded: "{rounded.md}"
    padding: 2px 8px
  badge-secondary-dark:
    backgroundColor: "{colors.muted-dark}"
    textColor: "{colors.muted-foreground-dark}"
  badge-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.badge}"
    rounded: "{rounded.md}"
    padding: 2px 8px
  badge-accent-dark:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.accent-foreground-dark}"

  # --- Alerts ---
  alert-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 12px 16px
  alert-destructive-dark:
    backgroundColor: "{colors.destructive-dark}"
    textColor: "{colors.destructive-foreground}"

  # --- Indicators ---
  warning-indicator:
    backgroundColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    size: 8px
  warning-indicator-dark:
    backgroundColor: "{colors.warning-dark}"
    rounded: "{rounded.pill}"
    size: 8px

  # --- Dividers ---
  hairline-divider:
    backgroundColor: "{colors.border}"
    height: 1px
  hairline-divider-dark:
    backgroundColor: "{colors.border-dark}"
    height: 1px

  # --- Code ---
  code-inline:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.xs}"
    padding: 2px 6px
  code-inline-dark:
    backgroundColor: "{colors.muted-dark}"
    textColor: "{colors.ink-dark}"
---

## Overview

toptopduck is a local-first AI data analysis workbench — not a marketing site. The UI serves long analytical sessions where users upload datasets, ask natural-language questions, review SQL execution traces, and inspect results tables and charts. Every design decision optimizes for **sustained focus and data legibility**, not visual impact.

The visual identity is a **calm, precise instrument**. Teal (`{colors.primary}` — #0d9488) is the sole brand accent — reserved for primary actions, active states, and focus rings. It never appears decoratively. The canvas is pure white in light mode and a dark surface (`{colors.canvas-dark}` — #0f1410) in dark mode. This dark canvas carries a subtle green undertone (G channel highest in RGB 15, 20, 16) that is visually harmonious with the teal brand color.

Type runs the **system font stack** (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`) across every UI role. SQL, data values, and code switch to the **system monospace stack** (`ui-monospace, SFMono-Regular, Menlo, ...`). The hierarchy is compact: the largest display token is 22px (cold-start hero only); the workhorse body size is 14px.

The structural signature is a **three-column shell**: session sidebar (220px) + conversation rail (320px) + workspace (flexible). Each column collapses independently — the shell animates panel width to zero rather than snapping. This is the product's spatial identity.

**Key Characteristics:**
- Single brand accent: `{colors.primary}` (teal #0d9488) for primary CTAs, active states, focus rings.
- Dual-mode equality: light and dark are both first-class; neither is the "default."
- Dark canvas (`{colors.canvas-dark}` — #0f1410) carries a green undertone visually harmonious with teal.
- Compact workbench density: 6px base radius, 36px button height, 40px topbar, 14px body text.
- Three-column collapsible shell as the structural signature.
- Brightness-step elevation: depth from surface luminance differences + a 3-tier functional shadow scale.
- Hairline-only borders (1px) for all visual separation.
- System font stack across every text role; system monospace on every code/SQL/data surface.
- Data-first surfaces: result tables, SQL traces, and charts are primary content — not cards or hero sections.

## Colors

### Brand
- **Teal** (`{colors.primary}` — #0d9488): The sole brand accent. Primary CTAs, active-session indicators, focus rings, and the active-dataset highlight. This color does not flip between modes — it is the one constant.
- **Teal Foreground** (`{colors.primary-foreground}` — #ffffff): White text on teal surfaces.

### Light Mode Surfaces
- **Canvas** (`{colors.canvas}` — #ffffff): The page floor. Pure white.
- **Card** (`{colors.card}` — #ffffff): Content card surface. Same white as canvas — cards elevate via hairline borders, not background contrast.
- **Popover** (`{colors.popover}` — #ffffff): Dialog and dropdown surface. Same white.
- **Secondary** (`{colors.secondary}` — #f1f5f4): Secondary button background. Faint green-gray tint.
- **Muted** (`{colors.muted}` — #f0f0f3): Badge backgrounds, code-inline backgrounds, subdued zones.
- **Border** (`{colors.border}` — #e3e3e8): The single hairline color for all 1px dividers, card outlines, and input borders.

### Light Mode Text
- **Ink** (`{colors.ink}` — #1a1a1a): Display, body, card text. Near-black (not pure #000 — softer for long sessions).
- **Muted Foreground** (`{colors.muted-foreground}` — #6b7280): Captions, metadata, disabled text, placeholder text.
- **Accent Foreground** (`{colors.accent-foreground}` — #0d9488): Text on accent-tinted backgrounds — same teal as primary.
- **Secondary Foreground** (`{colors.secondary-foreground}` — #1a1a1a): Text on secondary surfaces.

### Light Mode Accents
- **Accent** (`{colors.accent}` — #e6f4f1): Light teal tint for active/highlighted states (active-source indicator, selected session entry).
- **Destructive** (`{colors.destructive}` — #b00020): Error alerts, delete confirmations.
- **Warning** (`{colors.warning}` — #b45309): Stale-result indicators, viz-degradation warnings. Used as indicator dots and alert tints — never as solid fills.

### Dark Mode Surfaces
- **Canvas Dark** (`{colors.canvas-dark}` — #0f1410): The dark page floor. RGB 15, 20, 16 — the G channel is highest, giving the surface a subtle green undertone that is visually harmonious with the teal brand.
- **Card Dark** (`{colors.card-dark}` — #181b18): Content card surface. One brightness step above canvas.
- **Popover Dark** (`{colors.popover-dark}` — #181b18): Dialog surface. Same as card.
- **Secondary Dark** (`{colors.secondary-dark}` — #232723): Secondary button background in dark mode.
- **Muted Dark** (`{colors.muted-dark}` — #232723): Badge backgrounds, subdued zones. Same value as secondary-dark.
- **Border Dark** (`{colors.border-dark}` — #2a2f2a): Hairline color in dark mode. Greenish gray.

### Dark Mode Text
- **Ink Dark** (`{colors.ink-dark}` — #e8eae8): Primary text in dark mode. Soft off-white (not pure #ffffff — reduces eye strain).
- **Muted Foreground Dark** (`{colors.muted-foreground-dark}` — #9ca3af): Captions, metadata.
- **Accent Foreground Dark** (`{colors.accent-foreground-dark}` — #5eead4): Text on dark accent tints. Brighter teal than the brand color — lifts visibility on dark surfaces.

### Dark Mode Accents
- **Accent Dark** (`{colors.accent-dark}` — #143833): Dark teal tint for active/highlighted states.
- **Destructive Dark** (`{colors.destructive-dark}` — #ef4444): Error alerts in dark mode. Brighter red than light mode for visibility on dark canvas.
- **Warning Dark** (`{colors.warning-dark}` — #f59e0b): Warning indicators in dark mode. Brighter amber than light mode.

### Mode Mapping Principle
Light and dark tokens share semantic names but carry different hex values. The mapping is 1:1 — `{colors.canvas}` in light mode becomes `{colors.canvas-dark}` in dark mode. The `primary` and `primary-foreground` tokens are mode-invariant. Focus rings always use `{colors.primary}` (teal) in both modes. In production, the same CSS variable (`--background`, `--card`, etc.) carries different values under the `.dark` class — the DESIGN.md `-dark` suffix is a documentation convention, not a separate variable name.

## Typography

### Font Family
The **system font stack** (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`) carries every UI role — display, body, navigation, captions, and button labels. This gives a native feel on each platform: San Francisco on macOS, Segoe UI on Windows, Roboto on Linux.

The **system monospace stack** (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`) renders every code surface: SQL queries, data values in trace output, file paths, and identifiers.

### Hierarchy

| Token | Size | Weight | Tracking | Tailwind | Use |
|---|---|---|---|---|---|
| `{typography.display}` | 22px | 600 | -0.3px | `text-[1.4rem]` | Cold-start hero title only |
| `{typography.headline-lg}` | 20px | 600 | -0.2px | `text-xl` | Settings section headers |
| `{typography.headline-md}` | 18px | 600 | 0 | `text-lg` | Dialog titles, card titles |
| `{typography.headline-sm}` | 16px | 600 | 0 | `text-base` | Subsection labels, sidebar group headers |
| `{typography.body-md}` | 14px | 400 | 0 | `text-sm` | Default body, nav, table cells — the workhorse size |
| `{typography.body-sm}` | 13px | 400 | 0 | `text-[0.82rem]` | Technical details, tight metadata |
| `{typography.caption}` | 12px | 400 | 0 | `text-xs` | Metadata, timestamps, sublines |
| `{typography.label-caps}` | 12px | 600 | 0.05em | `text-xs` uppercase | Badges, section labels — render uppercase via CSS `text-transform: uppercase` |
| `{typography.code}` | 13px | 400 | 0 | `font-mono` | SQL, data values, file paths — system monospace |
| `{typography.button}` | 14px | 500 | 0 | `text-sm font-medium` | Button labels |
| `{typography.badge}` | 12px | 500 | 0 | `text-xs font-medium` | Badge labels — medium weight, no uppercase |
| `{typography.nav-link}` | 14px | 500 | 0 | `text-sm` | Sidebar entries, session list items |

### Principles
- **Compact hierarchy.** The largest token is 22px — this is a workbench, not a landing page. The workhorse body size is 14px (`text-sm`), not 16px — compact density for sustained data analysis sessions.
- **Weight discipline.** Display/headlines at 600, body at 400, buttons/nav at 500. Never use weight 700.
- **Negative tracking on display only.** `{typography.display}` and `{typography.headline-lg}` carry negative letter-spacing for tighter reading. Body and below have zero tracking.
- **Monospace on every code surface.** SQL, data values, trace output, file paths, and result identifiers always render in the system monospace stack — never in the sans stack.
- **Uppercase labels.** `{typography.label-caps}` defines the typographic properties (weight, tracking, size); apply CSS `text-transform: uppercase` at the element level. (Note: badge variants use `{typography.badge}` — medium weight, no uppercase — for a softer workbench feel; `{typography.label-caps}` is reserved for explicit section labels.)
- **Tailwind mapping.** The Tailwind column shows the nearest utility class. Ad-hoc values like `text-[0.82rem]` and `text-[0.85rem]` are visual-polish variants within the `{typography.body-sm}` range.

## Layout

### Spacing System
- **Base unit:** 4px.
- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.base}` 16px · `{spacing.md}` 20px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 64px.
- **Component padding:** 8–16px typical (inputs, buttons, cards). Generous internal padding on cards (16px) to keep data tables breathable.
- **Section rhythm:** 64px between major UI bands. Tighter than marketing-site rhythms (80–96px) because screen real estate is premium in a desktop workbench.

### Three-Column Shell
The structural signature. Three independently collapsible columns:

1. **Session sidebar** (220px): Session list grouped by recency. Collapses to 0 width (animated).
2. **Conversation rail** (320px): Thread of turns (questions + outcomes + source lifecycle events). Collapses to 0 width.
3. **Workspace** (flexible): Result tables, charts, dataset detail, privacy controls. Default collapsed in cold-start; expands when a turn produces results.

When the workspace folds, the conversation column promotes to primary surface and centers — a `minmax(0, 800px)` track capped at 800px with `1fr` spacers that shrink to 0 on narrow windows, so it centers at any viewport width.

### Grid
- Shell: `grid-template-columns: 220px 1fr` (sidebar + main block).
- Session pane: 4-track conversation grid — `0fr minmax(0, var(--rail-width)) 1fr 0fr` (spacer / conversation rail / workspace / spacer); the workspace-folded form `1fr minmax(0, 800px) 0fr 1fr` centers the conversation column. The shell-level question bar mirrors the same tracks so the bar sits under the conversation column (ADR-0092).
- Settings overlay: `grid-template-columns: 220px 1fr` (nav + content) — matches the sidebar width so the left boundary stays fixed when switching views.

### Whitespace Philosophy
Desktop workbench density — tighter than a web app, looser than an IDE. The canvas creates depth through surface brightness steps, so whitespace can stay compact without feeling crowded. 16px between cards; 8px between elements within a card.

## Elevation & Depth

The system uses **brightness-step elevation** — surfaces step up in luminance to create depth — supplemented by a **3-tier functional shadow scale** for floating layers and in-content card lift (issue #222, ADR-0067 (2)). Decorative shadows are forbidden; every shadow usage maps to one of three functional tiers.

### Shadow Tiers

| Tier | Utility | Use |
|---|---|---|
| In-content | `shadow-sm` | Cards, textual-card outcomes, working-set panels — lifts content above the canvas |
| Floating popover | `shadow-md` | Menus, dropdowns, select content, session-entry menu |
| Floating dialog | `shadow-lg` | Modals, alert dialogs, switch thumb |

These ride the Tailwind shadow scale directly (no custom `--shadow-*` token per ADR-0067 "no new elevation tokens"). The shadow serves the same depth purpose as brightness steps — it is functional, not decorative.

### Surface Levels

| Level | Light Treatment | Dark Treatment | Use |
|---|---|---|---|
| Canvas | `{colors.canvas}` (#ffffff) | `{colors.canvas-dark}` (#0f1410) | Page floor, topbar, sidebar |
| Card | `{colors.card}` (#ffffff) | `{colors.card-dark}` (#181b18) | Conversation rail, result tables, cards |
| Popover | `{colors.popover}` (#ffffff) | `{colors.popover-dark}` (#181b18) | Dialogs, dropdown menus |
| Hairline | 1px `{colors.border}` (#e3e3e8) | 1px `{colors.border-dark}` (#2a2f2a) | All visual separation |

### Depth Principles
- **Hairlines carry primary separation.** Every card, divider, and input border is a 1px hairline. There are no 2px borders.
- **Shadows lift floating layers and in-content cards.** The 3-tier scale (`shadow-sm` / `shadow-md` / `shadow-lg`) provides functional depth — in-content cards lift above the canvas, popovers float above content, dialogs float above all. No decorative shadow usage.
- **Light mode relies on hairline contrast + shadow-sm.** Cards share the same white as the canvas — the 1px `{colors.border}` plus `shadow-sm` defines the visual edge.
- **Dark mode uses brightness steps.** Canvas (#0f1410) → Card (#181b18) is a subtle but perceptible luminance step. The green undertone in both values is visually consistent with the teal brand.
- **Focus rings use teal.** `{colors.primary}` at 2px outline-offset. Not a shadow — a color ring.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Reserved |
| `{rounded.xs}` | 4px | Inline code chips, small tags |
| `{rounded.sm}` | 4px | Inline code chips, small tags |
| `{rounded.md}` | 6px | Badges, buttons, form inputs, text fields — the canonical radius |
| `{rounded.lg}` | 8px | Conversation rail, popovers, dialogs |
| `{rounded.xl}` | 10px | Cards (shadcn default) |
| `{rounded.pill}` | 9999px | Status indicators, warning dots |

Compact developer-ergonomic radii. The 6px base (vs shadcn's 10px default) signals "workbench tool" rather than "consumer app." Cards at 8px sit one step above buttons — enough to read as a container without softening the precise aesthetic.

### Derivation
All radius values derive from a single `{rounded.md}` token (6px): `xs/sm = md - 2px`, `lg = md + 2px`, `xl = md + 4px`. This mirrors the production CSS (`--radius-sm: calc(var(--radius) - 2px)` etc.).

## Components

### App Shell

**`app-shell` / `app-shell-dark`** — The window background. Background `{colors.canvas}` / `{colors.canvas-dark}`, text `{colors.ink}` / `{colors.ink-dark}`. In production this maps to the Tailwind `bg-background text-foreground` utilities.

**`topbar` / `topbar-dark`** — Thin 40px strip spanning the full viewport width. Same background as the shell. Houses the sidebar toggle, session name, and window controls. Height is deliberately compact — this is chrome, not content.

**`sidebar` / `sidebar-dark`** — Session sidebar at 220px width. Same background as the shell. Uses `{typography.nav-link}` for session entries. Collapsible to 0 width with a 180ms grid-template-columns animation.

### Conversation Surfaces

**`conversation-rail` / `conversation-rail-dark`** — The thread rail at 320px width. Background `{colors.card}` / `{colors.card-dark}` (one brightness step above canvas). Houses turn cards, source lifecycle markers, and the question bar at the bottom. Uses `{typography.body-sm}` as default text size.

### Cards & Containers

**`card` / `card-dark`** — Generic content card. Background `{colors.card}`, text `{colors.ink}`, rounded `{rounded.xl}` (10px, shadcn default), padding 24px (`py-6 px-6`), 1px `{colors.border}` hairline, `shadow-sm` lift. Used for turn cards, result containers, settings sections.

**`popover` / `popover-dark`** — Dialog, dropdown, and popover surface. Background `{colors.popover}`, rounded `{rounded.lg}`, padding 24px (`p-6`). Same surface as card.

### Buttons

**`button-primary`** — The teal CTA. Background `{colors.primary}`, text `{colors.primary-foreground}`, type `{typography.button}` (14px / 500), padding 8px × 16px, height 36px, rounded `{rounded.md}` (6px). Used for submit, confirm, and primary action in each view.

**`button-secondary` / `button-secondary-dark`** — Secondary surface button. Background `{colors.secondary}` / `{colors.secondary-dark}`, text matches ink. Same shape as primary.

**`button-outline` / `button-outline-dark`** — Transparent with 1px `{colors.border}` hairline. Text `{colors.ink}` / `{colors.ink-dark}`. Used for cancel, secondary actions.

### Inputs

**`text-input` / `text-input-dark`** — Transparent background, 1px `{colors.border}` hairline, text `{colors.ink}` / `{colors.ink-dark}`, type `{typography.body-md}`, rounded `{rounded.md}` (6px), padding 8px × 12px, height 36px. Focus state replaces the border with a 2px `{colors.primary}` ring. The shadcn Input/Textarea copy-in carries a mobile-first `text-base md:text-sm` responsive override (16px below the `md` breakpoint, then 14px) — a vestigial Safari auto-zoom prevention idiom from the shadcn default; Tauri desktop ignores the mobile breakpoint.

### Badges

**`badge-primary`** — Teal pill. Background `{colors.primary}`, text white, type `{typography.badge}` (12px / 500, no uppercase), rounded `{rounded.md}` (6px), padding 2px × 8px. Used for the active-dataset chip.

**`badge-secondary` / `badge-secondary-dark`** — Muted pill. Background `{colors.muted}`, text `{colors.muted-foreground}`. Used for session count, metadata tags.

**`badge-accent` / `badge-accent-dark`** — Teal-tinted pill. Background `{colors.accent}`, text `{colors.accent-foreground}`. Used for highlighted/active states in lists.

### Alerts

**`alert-destructive` / `alert-destructive-dark`** — Error alert. Background `{colors.destructive}` / `{colors.destructive-dark}`, text white, type `{typography.body-sm}`, rounded `{rounded.lg}`, padding 12px × 16px. In practice, shadcn Alert variants use tinted backgrounds (`bg-destructive/10`) with default text color — the solid tokens here define the semantic color reference.

**Warning alerts** use tinted backgrounds (`bg-warning/10`) with `{colors.warning}` / `{colors.warning-dark}` indicator dots (see below), not solid amber fills.

### Indicators

**`warning-indicator` / `warning-indicator-dark`** — Small status dot. Background `{colors.warning}` / `{colors.warning-dark}`, rounded `{rounded.pill}`, size 8px. Marks stale results, degraded visualizations, and cautionary disclosures.

### Dividers

**`hairline-divider` / `hairline-divider-dark`** — 1px horizontal or vertical separator. Background `{colors.border}` / `{colors.border-dark}`, height 1px. The universal separator — between cards, between rail sections, between table rows.

### Code

**`code-inline` / `code-inline-dark`** — Inline code chip. Background `{colors.muted}` / `{colors.muted-dark}`, text `{colors.ink}` / `{colors.ink-dark}`, type `{typography.code}` (system monospace 13px), rounded `{rounded.xs}` (4px), padding 2px × 6px. Used for SQL snippets, table names (`result_1`), and column references in prose.

## Do's and Don'ts

### Do
- Reserve `{colors.primary}` (teal) for primary CTAs, active states, and focus rings. One accent, used scarcely.
- Use brightness-step surfaces + functional shadow tiers for depth. In-content cards carry `shadow-sm`; floating popovers carry `shadow-md`; dialogs carry `shadow-lg`.
- Render every SQL snippet, data value, and file path in the system monospace stack via `{typography.code}`.
- Keep button height at 36px and topbar at 40px — compact workbench density.
- Use 1px hairlines (`{colors.border}` / `{colors.border-dark}`) for all visual separation.
- Support both light and dark modes as equals. Neither is the "default."
- Apply `{typography.label-caps}` with CSS `text-transform: uppercase` for badges and section labels.
- Collapse shell panels with animated grid-template-columns transitions (180ms ease), not display:none.

### Don't
- Don't introduce a secondary brand color. Teal is the only chromatic accent.
- Don't use decorative drop shadows. The 3-tier functional shadow scale (`shadow-sm` / `shadow-md` / `shadow-lg`) is the only shadow usage — no ad-hoc shadow values, no custom shadow tokens.
- Don't use font weight 700. Display caps at 600; body stays at 400.
- Don't animate layout-bound properties (width, height, top, left). Animate `grid-template-columns` and `opacity` for panel transitions.
- Don't use `{colors.warning}` as a solid fill for alert backgrounds. Use tinted backgrounds (`bg-warning/10`) with warning indicator dots.
- Don't use pure `#000000` for dark canvas. `{colors.canvas-dark}` (#0f1410) carries a green undertone that distinguishes the dark palette from neutral gray-black.
- Don't use pure `#ffffff` for dark-mode text. `{colors.ink-dark}` (#e8eae8) is softer for long sessions.
- Don't create new radius values. All corners derive from the 6px `{rounded.md}` token.
- Don't place large areas of white body text on teal `{colors.primary}` (#0d9488). The contrast ratio is 3.74:1 — passes WCAG AA Large (3:1, suitable for button labels and short badges at 14px/500) but not AA normal text (4.5:1). For body text on teal surfaces, use `{colors.ink-dark}` on a darker teal tint instead.
