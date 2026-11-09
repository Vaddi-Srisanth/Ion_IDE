import { useState, type FormEvent } from 'react';
import { themeColorKeys, themeSyntaxKeys, type ThemeData, type ThemeDefinition } from '../../shared/themes';

const workbenchColors = themeColorKeys.filter((key) => !key.startsWith('editor-'));
const editorColors = themeColorKeys.filter((key) => key.startsWith('editor-'));
const labels: Record<string, string> = {
  ink: 'Strong text',
  dim: 'Secondary text',
  mint: 'Success text',
  lilac: 'Informational text',
  amber: 'Warning text',
  danger: 'Error text',
  'accent-ink': 'Text on accent',
  'accent-bg': 'Tinted background',
  'warning-bg': 'Warning background',
};
const labelFor = (key: string) => {
  const text = key.replace(/^editor-/, '').replaceAll('-', ' ');
  return labels[key] ?? text[0].toUpperCase() + text.slice(1);
};

export default function ThemeBuilder({ base, busy, onSave, onCancel }: {
  base: ThemeData;
  busy: boolean;
  onSave(draft: ThemeDefinition): void;
  onCancel(): void;
}) {
  const [baseName] = useState(base.name);
  const [draft, setDraft] = useState<ThemeDefinition>(() => ({
    version: 1,
    name: '',
    appearance: base.appearance,
    colors: { ...base.colors },
    syntax: { ...base.syntax },
  }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!busy && name) onSave({ ...draft, name });
  }

  function colorField(key: (typeof themeColorKeys)[number]) {
    return <label className="theme-color" key={key}>
      <span>{labelFor(key)}</span>
      <input type="color" data-testid={`theme-color-${key}`} value={draft.colors[key]}
        onChange={(event) => {
          const value = event.target.value;
          setDraft((previous) => ({ ...previous, colors: { ...previous.colors, [key]: value } }));
        }}/>
    </label>;
  }

  return <form className="theme-builder" aria-label="Create a custom theme" onSubmit={submit}>
    <fieldset disabled={busy}>
      <div className="theme-builder-heading">
        <div><b>Create a custom theme</b><p>Starts with the colors of {baseName}.</p></div>
        <span className="theme-kind">{draft.appearance} theme</span>
      </div>
      <label className="theme-name">
        <span>Theme name</span>
        <input type="text" data-testid="theme-name" autoFocus required placeholder="My theme"
          maxLength={64} value={draft.name}
          onChange={(event) => {
            const name = event.target.value;
            setDraft((previous) => ({ ...previous, name }));
          }}/>
      </label>
      <details>
        <summary>Workbench colors</summary>
        <div className="theme-color-grid">{workbenchColors.map(colorField)}</div>
      </details>
      <details>
        <summary>Editor colors</summary>
        <div className="theme-color-grid">{editorColors.map(colorField)}</div>
      </details>
      <details>
        <summary>Syntax highlighting</summary>
        <div className="theme-color-grid">
          {themeSyntaxKeys.map((key) => <label className="theme-color" key={key}>
            <span>{labelFor(key)}</span>
            <input type="color" data-testid={`theme-syntax-${key}`} value={draft.syntax[key]}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((previous) => ({ ...previous, syntax: { ...previous.syntax, [key]: value } }));
              }}/>
          </label>)}
        </div>
      </details>
      <div className="theme-tools">
        <button className="button" type="button" onClick={onCancel}>Cancel</button>
        <button className="button primary" type="submit" data-testid="theme-create-submit"
          disabled={!draft.name.trim()}>{busy ? 'Saving…' : 'Save Theme'}</button>
      </div>
    </fieldset>
  </form>;
}
