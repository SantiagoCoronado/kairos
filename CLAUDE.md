# Kairos

## UI conventions

- Floating chrome (popovers, menus, dropdowns, modals, toasts) uses `bg-overlay`,
  never `bg-panel`. `bg-panel` is a 3.5%-alpha lift for nested surfaces on opaque
  columns — on a floating element the content underneath bleeds through.
  Enforced by `src/renderer/popover-opacity.test.ts`.
- Controls passed to a settings `Row` render inside a `shrink-0` wrapper; keep it
  that way so long hint text can never clip them.
