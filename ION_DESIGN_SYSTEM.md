# Ion design system — precision and energy

## Focused design studies

1. **Instrument panel:** graphite surfaces, compact blue focus, fine structural rules, quiet typography, code as the main area. Clear file and learning hierarchy. Selected for implementation.
2. **Editorial workspace:** larger prose and warm neutral sheets. Useful for long lessons, but too much spacing would reduce code visibility on laptops. Retain readable prose only inside lessons.
3. **Luminous studio:** cyan emphasis, bright separators and decorative orbital graphics. Expressive but competes with syntax and errors. Keep the existing mark; remove decorative hero dominance from daily entry.

These are design studies, not three shipped themes. They use the existing theme engine and icons. No fonts, images, UI framework or animation dependency is added.

## Token contract

Existing semantic theme colors remain authoritative, including imported themes. Component tokens alias those colors: background, panel/surface, border, ink/text/muted, accent and feedback. Layout tokens define a 4 px spacing grid, 42 px titlebar, compact tabs and toolbar controls, 26 px statusbar, restrained 4–8 px radii and visible 2 px focus outlines. Existing split-pane settings and keyboard resizing remain intact.

Use the OS UI font and existing monospace stack. Keep body text readable at 12–13 px, lesson prose at 12–13 px with generous line height, small metadata at 10–11 px. Use weight and structure before adding color. Blue is the intended default accent; custom themes retain their own palettes. No required theme-schema keys are introduced.

## Interaction rules

Code remains dominant. Learn and Projects are explicit optional destinations. Practice remains available through Learn and its existing command/Welcome route. Project Lens receives navigation only with a functioning offline implementation. Do not add inactive controls pretending to analyze a project. All icon controls retain accessible names, tooltips and keyboard focus. No new motion or expensive visual effects.
