import { useState } from 'react';
import { formatterFamily, languageCapabilities, languageCapability, type SemanticOperation } from '../shared/languages';
import { Modal } from './Dialogs';

const operationLabels: Record<SemanticOperation, string> = {
  diagnostics: 'Diagnostics', complete: 'Autocomplete', signature: 'Signatures',
  definition: 'Go to Definition', references: 'Find References', hover: 'Hover',
};

export default function LanguageSupport({ initial, onClose }: { initial?: string; onClose(): void }) {
  const [id, setId] = useState(initial && languageCapability(initial) ? initial : 'c');
  const language = languageCapability(id)!;
  const extensions = (values: readonly string[]) => values.map((ext) => '.' + ext).join(', ');
  const formatExtensions = language.extensions.filter((ext) => formatterFamily('file.' + ext));
  const detail = [
    ['Syntax highlighting', language.syntax ? 'Available in source editor' : 'Plain text'],
    ['Run Console', language.runner ? `Requires ${language.runner.tools} · ${extensions(language.runner.extensions)}` : 'Unavailable'],
    ['Format Document', language.formatter ? `Requires ${language.formatter.tools} · ${extensions(formatExtensions)}` : 'Unavailable'],
    ['Basic suggestions', language.basicSuggestions ? 'Keywords and snippets' : 'Unavailable'],
    ['Semantic tools', language.semantic
      ? `Optional · ${language.semantic.tools} · ${language.semantic.operations.map((operation) => operationLabels[operation]).join(', ')}`
      : 'Unavailable'],
    ['Debugger', language.debugAdapter ?? 'Unavailable'],
    ['Offline lessons', language.pack ? 'Available in Marketplace' : 'Unavailable'],
    ['Diagnostic lessons', language.diagnosticLessons === 'source-linked' ? 'Learning Lens · selected compiler errors'
      : language.diagnosticLessons === 'reviewed' ? 'Selected explanations in Learn' : 'Unavailable'],
    ['Practice', language.practice ? 'Local sample tests available' : 'Unavailable'],
    ['Quizzes', language.quizzes ? 'Available' : 'Unavailable'],
  ];
  return <Modal title="Language Support" className="preferences" onClose={onClose}>
    <div className="settings-group">
      <label className="setting">Language<select value={id} onChange={(event) => setId(event.target.value)}>
        {languageCapabilities.map(({ id: value, label }) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <p>{extensions(language.extensions)}</p>
      <dl>
        {detail.map(([label, value]) => <div className="setting" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </div>
    <div className="modal-actions"><button className="button primary" type="button" onClick={onClose}>Done</button></div>
  </Modal>;
}
