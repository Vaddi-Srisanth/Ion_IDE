import { Icon } from './icons';
import type { RecentEntry, WorkspaceMode } from '../shared/contracts';
import { basename } from './paths';

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
        <header className="welcome-hero precision-hero">
          <div className="hero-copy">
            <div className="eyebrow"><Icon name="logo" size={20}/> ION / YOUR WORKSPACE</div>
            <h1>Write better code.<br/><span>Understand what you build.</span></h1>
            <p>Your editor, local tools, and a place to work things out.</p>
          </div>
          <span className="welcome-local"><span className="signal"/> Local by default</span>
        </header>

        <section className="welcome-start" aria-label="Start coding">
              <div className="welcome-actions precision-actions">
                <button className="button primary" data-testid="open-folder" onClick={onFolder}><Icon name="open" size={16}/> Open Project <Icon name="arrow" size={15}/></button>
                <div className="new-file-group">
                  <button className="button" data-testid="new-file" onClick={onNew}><Icon name="plus"/> New File</button>
                  <button className="button" aria-label="New file from starter" title="New file from starter" data-testid="new-starter"
                    onClick={onNewStarter}><Icon name="down" size={14}/></button>
                </div>
                <button className="button" data-testid="open-file" onClick={onFile}><Icon name="file" size={15}/> Open File</button>
              </div>
        </section>

        <div className="welcome-content">
        <section className="recent-section" aria-label="Recent locations">
          <div className="section-caption"><h2><Icon name="clock" size={14}/> Recent work</h2><span>ON THIS DEVICE</span></div>
          {recent.length === 0
            ? <div className="welcome-no-recents"><Icon name="folder" size={22}/><p>No recent projects yet.</p><span>Open a folder or start with a single file.</span></div>
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
        <section className="welcome-pathways" aria-label="Learn and build">
          <div className="section-caption"><h2>A little further</h2></div>
          <article className="welcome-destination">
            <Icon name="book" size={19}/><div><button type="button" data-testid="workspace-learn" onClick={() => onWorkspace('learn')}>Continue Learning <Icon name="arrow" size={14}/></button>
              <p>Explore a concept, then put it into code.</p>
              <button type="button" className="welcome-secondary" data-testid="workspace-practice" onClick={() => onWorkspace('practice')}><Icon name="flask" size={13}/> Practice Lab</button>
            </div>
          </article>
          <article className="welcome-destination">
            <Icon name="map" size={19}/><div><button type="button" data-testid="workspace-projects" onClick={() => onWorkspace('projects')}>Project Roadmaps <Icon name="arrow" size={14}/></button>
              <p>Plan the work. Verify the result.</p>
            </div>
          </article>
          <p className="welcome-principle">Your code deserves the memory.<br/>Your editor doesn't.</p>
        </section>
        </div>
      </div>
    </main>
  );
}
