import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadEditor } from './load-editor';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('Ion window is missing its root container.');

function mount() {
  createRoot(host!).render(<App/>);
}

if (import.meta.env.VITE_ION_EAGER_EDITOR === '1') {
  void loadEditor().then(mount, mount);
} else {
  mount();
}
