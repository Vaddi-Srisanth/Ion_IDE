import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import type { WorkspaceMode } from '../../shared/contracts';
import { Icon, type IconName } from '../icons';
import './onboarding.css';

const motionQuery = '(prefers-reduced-motion: reduce)';
const routes: { id: WorkspaceMode; title: string; detail: string; icon: IconName }[] = [
  { id: 'free', title: 'Free Coding', detail: 'An open editor for whatever you’re building.', icon: 'code' },
  { id: 'learn', title: 'Learn a Language', detail: 'Offline lessons beside your own code.', icon: 'book' },
  { id: 'projects', title: 'Create a Project', detail: 'Plan milestones and check real behavior.', icon: 'map' },
  { id: 'practice', title: 'Practice Coding', detail: 'Local challenges, samples, and attempts.', icon: 'flask' },
];

interface OnboardingProps {
  replay: boolean;
  error?: string;
  onClose(): void;
  onStart(): void;
  onOpenFolder(): void;
  onWorkspace(mode: WorkspaceMode): void;
}

export function Onboarding({ replay, error, onClose, onStart, onOpenFolder, onWorkspace }: OnboardingProps) {
  const [playing, setPlaying] = useState(() => !matchMedia(motionQuery).matches);
  const [Cinematic, setCinematic] = useState<ComponentType<{ onFinish(): void }>>();
  const dialog = useRef<HTMLDialogElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useLayoutEffect(() => { firstAction.current?.focus(); }, [playing]);

  const finish = useCallback(() => {
    if (replay) onClose();
    else setPlaying(false);
  }, [onClose, replay]);

  useEffect(() => {
    if (!playing) return;
    let current = true;
    const motion = matchMedia(motionQuery);
    const preferStatic = () => { if (motion.matches) setPlaying(false); };
    motion.addEventListener('change', preferStatic);
    const deadline = setTimeout(finish, 2500);
    if (motion.matches) preferStatic();
    else void import('./CinematicIntro').then(({ default: Scene }) => {
      if (current) setCinematic(() => Scene);
    }).catch(() => { if (current) finish(); }).finally(() => clearTimeout(deadline));
    return () => {
      current = false;
      clearTimeout(deadline);
      motion.removeEventListener('change', preferStatic);
    };
  }, [finish, playing]);

  return <dialog ref={dialog} className={`ion-onboarding ${playing ? 'ion-onboarding-playing' : ''}`}
    aria-label={playing ? 'Ion IDE introduction' : 'Get started with Ion IDE'} data-testid="onboarding"
    onCancel={(event) => { event.preventDefault(); if (playing) finish(); else onClose(); }}>
    {playing ? <>
      {Cinematic && <Cinematic onFinish={finish}/>}
      <div className="onboarding-intro-actions">
        <button ref={firstAction} className="button" type="button" data-testid="onboarding-skip-intro" onClick={finish}>
          Skip Intro <kbd>Esc</kbd>
        </button>
        {!replay && <button className="button" type="button" data-testid="onboarding-skip-setup" onClick={onClose}>Skip Setup</button>}
      </div>
    </> : <div className="onboarding-setup">
      <div className="onboarding-banner">
        <div className="onboarding-index"><span className="signal"/> ION IDE <span>///</span> {replay ? 'INTRO' : 'FIRST LAUNCH'}</div>
        <div className="onboarding-mark"><Icon name="logo" size={54}/></div>
        <h1>Write code.<br/>Understand errors.<br/><em>Learn offline.</em></h1>
        {!replay && <p>Choose a starter, make it yours, then press Run. Ion checks for the local compiler or runtime when you run it.</p>}
        <div className="onboarding-actions">
          {replay
            ? <button ref={firstAction} className="button primary" type="button" onClick={onClose}>Back to Ion</button>
            : <>
              <button ref={firstAction} className="button primary" type="button" data-testid="onboarding-start" onClick={onStart}>
                Get Started <Icon name="arrow" size={15}/>
              </button>
              <button className="button" type="button" data-testid="onboarding-open-folder" onClick={onOpenFolder}>
                <Icon name="open" size={16}/> Open Existing Folder
              </button>
              <button className="button onboarding-skip" type="button" data-testid="onboarding-skip-setup" onClick={onClose}>Skip Setup</button>
            </>}
        </div>
        {error && <p className="onboarding-error" role="alert">{error}</p>}
      </div>
      {!replay && <section className="onboarding-routes" aria-label="Choose a workspace">
        <div className="onboarding-index">CHOOSE A WORKSPACE <span>01—04</span></div>
        {routes.map((route) => <button key={route.id} type="button" data-testid={`onboarding-${route.id}`}
          onClick={() => onWorkspace(route.id)}>
          <span className="onboarding-route-icon"><Icon name={route.icon} size={18}/></span>
          <span><strong>{route.title}</strong><small>{route.detail}</small></span>
          <Icon name="arrow" size={14}/>
        </button>)}
      </section>}
    </div>}
  </dialog>;
}
