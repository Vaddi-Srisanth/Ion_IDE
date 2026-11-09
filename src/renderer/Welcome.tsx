import { Icon, type IconName } from './icons';
import type { RecentEntry, WorkspaceMode } from '../shared/contracts';
import { basename } from './paths';

const workspaces: { mode: Exclude<WorkspaceMode, 'free'>; name: string; description: string; icon: IconName; color: string }[] = [
  { mode: 'learn', name: 'Learn', description: 'Choose a language pack and study it beside your code.', icon: 'book', color: 'mint' },
  { mode: 'projects', name: 'Projects', description: 'Plan milestones and verify working software.', icon: 'map', color: 'lilac' },
  { mode: 'practice', name: 'Practice', description: 'Solve problems and revisit earlier attempts.', icon: 'flask', color: 'amber' },
];

interface WelcomeProps {
  recent: RecentEntry[];
  onNew(): void;
  onNewStarter(): void;
  onFile(): void;
  onFolder(): void;
  onRecent(entry: RecentEntry): void;
  onWorkspace(mode: WorkspaceMode): void;
}

export function Welcome({ recent, onNew, onNewStarter, onFile, onFolder, onRecent, onWorkspace }: WelcomeProps) {
  return (
    <main className="welcome" data-testid="welcome">
      <div className="welcome-inner">
        <header className="welcome-hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="signal" /> LOCAL DEVELOPMENT ENVIRONMENT</div>
            <h1>Ion<span className="hero-dot">.</span></h1>
            <p>A focused desktop IDE for writing, running,<br className="hero-break" /> and understanding your own code.</p>
          </div>
          <svg className="hero-art" viewBox="0 0 360 190" fill="none" aria-hidden="true">
            <defs>
              <pattern id="hero-grid" width="18" height="18" patternUnits="userSpaceOnUse">
                <path d="M18 0H0v18" className="art-grid"/>
              </pattern>
            </defs>
            <path d="M15 5h325v180H15z" fill="url(#hero-grid)" />
            <path d="M15 23V5h18m288 0h19v18M15 166v19h18m288 0h19v-19M178 5v180M15 95h325" className="art-grid"/>
            <circle cx="178" cy="95" r="76" className="art-muted" strokeDasharray="3 5"/>
            <circle cx="178" cy="95" r="59" className="art-muted"/>
            <ellipse cx="178" cy="95" rx="132" ry="39" transform="rotate(-23 178 95)" className="art-orbit"/>
            <ellipse cx="178" cy="95" rx="119" ry="32" transform="rotate(25 178 95)" className="art-muted"/>
            <path d="M148 117l25-50h15l-25 50zm27 0 25-50h9l-25 50z" className="art-glyph"/>
            <circle cx="294" cy="56" r="4" className="art-glyph"/>
            <circle cx="76" cy="65" r="3" className="art-point"/>
            <path d="M287 139h8m-4-4v8m-225-14h8m-4-4v8" className="art-orbit"/>
          </svg>
        </header>

        <section className="workspace-section" aria-label="Workspaces">
          <div className="section-caption"><h2>Workspaces</h2><span>01—04</span></div>
          <div className="workspace-list">
            <article className="workspace-option workspace-active">
              <div className="workspace-symbol"><Icon name="code" size={21}/></div>
              <div className="workspace-summary">
                <h3>Free Coding <span className="workspace-ready"><span/> AVAILABLE</span></h3>
                <p>Open a folder or file, edit, and run code locally.</p>
              </div>
              <div className="welcome-actions">
                <div className="new-file-group">
                  <button className="button" data-testid="new-file" onClick={onNew}><Icon name="plus"/> New File</button>
                  <button className="button" aria-label="New file from starter" title="New file from starter" data-testid="new-starter"
                    onClick={onNewStarter}><Icon name="down" size={14}/></button>
                </div>
                <button className="button" data-testid="open-file" onClick={onFile}>Open File</button>
                <button className="button primary" data-testid="open-folder" onClick={onFolder}>Open Folder <Icon name="arrow" size={15}/></button>
              </div>
            </article>
            {workspaces.map((entry) => (
              <article key={entry.mode} className="workspace-option future-workspace">
                <div className={`workspace-symbol ${entry.color}`}><Icon name={entry.icon} size={19}/></div>
                <div className="workspace-summary"><h3>{entry.name}</h3><p>{entry.description}</p></div>
                <button className="button" data-testid={`workspace-${entry.mode}`} onClick={() => onWorkspace(entry.mode)}>Open {entry.name}<Icon name="arrow" size={14}/></button>
              </article>
            ))}
          </div>
        </section>

        <section className="recent-section" aria-label="Recent locations">
          <div className="section-caption"><h2><Icon name="clock" size={14}/> Recent</h2></div>
          {recent.length === 0
            ? <p className="recent-empty">Files and folders you open will appear here.</p>
            : <ul className="recent-list">
              {recent.slice(0, 5).map((entry) => (
                <li key={entry.path}>
                  <button className="recent-entry" title={entry.path} onClick={() => onRecent(entry)}>
                    <Icon name={entry.kind === 'folder' ? 'folder' : 'file'} size={15}/>
                    <strong>{basename(entry.path)}</strong><span>{entry.path}</span><Icon name="diagonal" size={13}/>
                  </button>
                </li>
              ))}
            </ul>}
        </section>
      </div>
    </main>
  );
}
