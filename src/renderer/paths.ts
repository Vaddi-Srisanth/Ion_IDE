export function basename(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path;
}

export function isWithin(path: string, parent: string): boolean {
  if (path === parent) return true;
  if (/[/\\]$/.test(parent)) return path.startsWith(parent);
  return path.startsWith(`${parent}/`) || path.startsWith(`${parent}\\`);
}

export function languageFor(name: string): { id: string; label: string } {
  if (name.endsWith('.C')) return { id: 'cpp', label: 'C++' };
  const ext = name.split('.').at(-1)?.toLowerCase();
  switch (ext) {
    case 'c': case 'h': return { id: 'c', label: 'C' };
    case 'cpp': case 'cxx': case 'cc': case 'c++': case 'hpp': return { id: 'cpp', label: 'C++' };
    case 'js': case 'mjs': case 'cjs': case 'jsx': return { id: 'javascript', label: 'JavaScript' };
    case 'ts': case 'tsx': return { id: 'typescript', label: 'TypeScript' };
    case 'json': case 'ipynb': return { id: 'json', label: 'JSON' };
    case 'py': case 'python': return { id: 'python', label: 'Python' };
    case 'html': case 'htm': return { id: 'html', label: 'HTML' };
    case 'css': return { id: 'css', label: 'CSS' };
    case 'md': case 'markdown': return { id: 'markdown', label: 'Markdown' };
    case 'sh': case 'bash': case 'zsh': return { id: 'shell', label: 'Shell' };
    case 'java': return { id: 'java', label: 'Java' };
    case 'go': return { id: 'go', label: 'Go' };
    case 'rs': return { id: 'rust', label: 'Rust' };
    case 'sql': return { id: 'sql', label: 'SQL' };
    case 'yaml': case 'yml': return { id: 'yaml', label: 'YAML' };
    default: return { id: 'plaintext', label: 'Plain Text' };
  }
}
