import { editor } from 'monaco-editor/editor/editor.api.js';
import { themeSyntaxKeys, type ThemeData } from '../../shared/themes';

const activeSlot = 'ion-active';

export function applyEditorTheme(theme: ThemeData, accentOverride?: string): void {
  const { colors, syntax } = theme;
  const accent = accentOverride ?? colors.accent;
  // Monaco replaces this slot and refreshes its CSS in place. Theme IDs from the
  // catalog never become permanent entries in Monaco's theme service.
  editor.defineTheme(activeSlot, {
    base: theme.appearance === 'light' ? 'vs' : 'vs-dark',
    inherit: false,
    rules: themeSyntaxKeys.map((token) => ({
      token,
      foreground: syntax[token].slice(1),
      ...(token === 'comment' ? { fontStyle: 'italic' } : {}),
    })),
    colors: {
      'foreground': colors.text,
      'focusBorder': accent,
      'editor.background': colors.background,
      'editor.foreground': colors['editor-foreground'],
      'editorLineNumber.foreground': colors['editor-line-number'],
      'editorLineNumber.activeForeground': colors['editor-active-line-number'],
      'editorCursor.foreground': accent,
      'editor.selectionBackground': colors['editor-selection'],
      'editor.inactiveSelectionBackground': colors['editor-selection'],
      'editor.lineHighlightBackground': colors['editor-line-highlight'],
      'editor.lineHighlightBorder': colors['editor-line-highlight'],
      'editorIndentGuide.background1': colors['editor-indent'],
      'editorIndentGuide.activeBackground1': colors['editor-active-indent'],
      'editorWidget.background': colors.surface,
      'editorWidget.foreground': colors.text,
      'editorWidget.border': colors.border,
      'input.background': colors.background,
      'input.foreground': colors.text,
      'input.border': colors.border,
      'dropdown.background': colors.surface,
      'dropdown.foreground': colors.text,
      'dropdown.border': colors.border,
      'menu.background': colors.surface,
      'menu.foreground': colors.text,
      'menu.border': colors.border,
      'menu.selectionBackground': colors['accent-bg'],
      'menu.selectionForeground': colors.ink,
      'menu.separatorBackground': colors.border,
      'editorHoverWidget.background': colors.surface,
      'editorHoverWidget.foreground': colors.text,
      'editorHoverWidget.border': colors.border,
      'editorSuggestWidget.background': colors.surface,
      'editorSuggestWidget.foreground': colors.text,
      'editorSuggestWidget.border': colors.border,
      'editorSuggestWidget.selectedBackground': colors['accent-bg'],
      'editorSuggestWidget.selectedForeground': colors.ink,
      'editorSuggestWidget.highlightForeground': accent,
      'editorBracketMatch.border': accent,
      'editorError.foreground': colors.danger,
      'editorWarning.foreground': colors.amber,
      'editorInfo.foreground': accent,
      'editor.findMatchBackground': colors['editor-selection'],
      'editor.findMatchBorder': accent,
      'editor.findMatchHighlightBackground': colors['editor-selection'],
    },
  });
  editor.setTheme(activeSlot);
}

export function clearEditorTheme(): void {
  editor.setTheme('vs-dark');
  editor.defineTheme(activeSlot, { base: 'vs-dark', inherit: true, rules: [], colors: {} });
}
