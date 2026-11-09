import { useState } from 'react';
import { commandEntries, displayShortcut, effectiveShortcut, normalizeShortcut, shortcutIssue,
  type MenuCommand, type ShortcutOverrides, type ShortcutPlatform } from '../shared/shortcuts';
import { errorMessage } from './documents';

export function ShortcutSettings({ overrides, platform, onSave }: {
  overrides: ShortcutOverrides;
  platform: ShortcutPlatform;
  onSave(overrides: ShortcutOverrides): Promise<void>;
}) {
  const [command, setCommand] = useState<MenuCommand>('command-palette');
  const [input, setInput] = useState(effectiveShortcut(command, overrides, platform));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error?: boolean; text: string }>();
  async function apply(reset = false) {
    const shortcut = reset ? effectiveShortcut(command, {}, platform) : normalizeShortcut(input, platform);
    if (shortcut === null) {
      setStatus({ error: true, text: 'Enter a shortcut such as Mod+Shift+P or F6. Leave it blank to remove it.' });
      return;
    }
    const next = { ...overrides };
    if (shortcut === effectiveShortcut(command, {}, platform)) delete next[command];
    else next[command] = shortcut;
    const issue = shortcutIssue(next, platform);
    if (issue) {
      setStatus({ error: true, text: issue });
      return;
    }
    setBusy(true);
    setStatus(undefined);
    try {
      await onSave(next);
      setInput(shortcut);
      setStatus({ text: 'Shortcut saved.' });
    } catch (reason) {
      setStatus({ error: true, text: errorMessage(reason) });
    } finally {
      setBusy(false);
    }
  }
  return <details className="settings-group shortcut-settings">
    <summary>Keyboard Shortcuts</summary>
    <form className="entry-form" onSubmit={(event) => { event.preventDefault(); void apply(); }}>
      <div className="setting"><label htmlFor="shortcut-command">Command</label>
        <select id="shortcut-command" data-testid="shortcut-command" value={command} disabled={busy}
          onChange={(event) => {
            const selected = event.target.value as MenuCommand;
            setCommand(selected);
            setInput(effectiveShortcut(selected, overrides, platform));
            setStatus(undefined);
          }}>
          {commandEntries.map(([id, { label }]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <label htmlFor="shortcut-binding">Shortcut</label>
      <input id="shortcut-binding" data-testid="shortcut-binding" value={input} maxLength={64} spellCheck={false}
        aria-describedby="shortcut-help" disabled={busy} onChange={(event) => { setInput(event.target.value); setStatus(undefined); }}/>
      <p className="picker-note" id="shortcut-help">Use Mod for {platform === 'darwin' ? 'Command' : 'Control'}. Enter a key combination such as Mod+Shift+P or F6.
        Current shortcut is {displayShortcut(command, overrides, platform) || 'unassigned'}.</p>
      {status && <p className={status.error ? 'form-error' : 'picker-note'} role={status.error ? 'alert' : 'status'}>{status.text}</p>}
      <div className="modal-footer">
        <button className="button" type="button" disabled={busy} onClick={() => void apply(true)}>Restore Default</button>
        <button className="button primary" type="submit" data-testid="shortcut-apply" disabled={busy}>Apply Shortcut</button>
      </div>
    </form>
  </details>;
}
