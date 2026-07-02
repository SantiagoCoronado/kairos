// The main window is created transparent; actual opacity is CSS-driven so the
// translucency slider works live without recreating the window.
export function applyTranslucency(pct: number): void {
  const alpha = 1 - Math.min(60, Math.max(0, pct)) / 100
  document.documentElement.style.setProperty('--bg-alpha', alpha.toFixed(3))
}
