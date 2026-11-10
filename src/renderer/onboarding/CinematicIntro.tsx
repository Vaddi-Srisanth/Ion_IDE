import { useEffect, useEffectEvent, useRef } from 'react';
import { Icon } from '../icons';
import './cinematic-intro.css';

const width = 720;
const height = 450;
const centerX = width / 2;
const centerY = height * .48;
const duration = 7_800;
const frameInterval = 1000 / 30;
const turn = Math.PI * 2;

function smooth(from: number, to: number, time: number) {
  const progress = Math.max(0, Math.min(1, (time - from) / (to - from)));
  return progress * progress * (3 - 2 * progress);
}

function mix(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

type Color = readonly [number, number, number];

function color(from: Color, to: Color, progress: number, alpha = 1) {
  return `rgba(${Math.round(mix(from[0], to[0], progress))},${Math.round(mix(from[1], to[1], progress))},${Math.round(mix(from[2], to[2], progress))},${alpha})`;
}

function starField() {
  // Fixed geometry keeps the camera movement reproducible across replays.
  let seed = 519;
  const next = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: 76 }, () => ({
    x: (next() - .5) * width,
    y: (next() - .48) * height,
    depth: .2 + next() * .8,
    light: .2 + next() * .8,
  }));
}

const stars = starField();
const orbits = [
  { tilt: -.46, radiusX: 138, radiusY: 36, origin: .2, speed: .0033, tone: '#7de8ff' },
  { tilt: .53, radiusX: 122, radiusY: 39, origin: 2.4, speed: -.0029, tone: '#5bb2ff' },
  { tilt: -1.33, radiusX: 104, radiusY: 28, origin: 4.5, speed: .0035, tone: '#b2f7ff' },
];

function disc(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  context.beginPath();
  context.arc(x, y, radius, 0, turn);
  context.fill();
}

function glow(context: CanvasRenderingContext2D, x: number, y: number, radius: number, inner: string, middle: string) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(.32, middle);
  gradient.addColorStop(1, 'transparent');
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function paintStars(context: CanvasRenderingContext2D, time: number, approach: number, retreat: number) {
  const bloom = smooth(2_200, 3_150, time) * (1 - smooth(3_300, 4_150, time));
  const visibility = (.16 + smooth(0, 1_150, time) * .63) * (1 - bloom * .91);
  const expansion = approach * 2.4 * (1 - retreat);
  context.fillStyle = '#b2c9e4';
  for (const { x, y, depth, light } of stars) {
    const scale = 1 + expansion * depth;
    const size = light > .89 ? 1.5 : .85;
    context.globalAlpha = visibility * light * depth;
    context.fillRect(centerX + x * scale, centerY + y * scale, size, size);
  }
  context.globalAlpha = 1;
}

function paintSun(context: CanvasRenderingContext2D, time: number, approach: number, retreat: number) {
  const cool = smooth(1_420, 2_960, time);
  const distance = 3 + 20 * smooth(0, 2_400, time) + 439 * approach ** 2;
  const radius = mix(distance, 9, retreat);
  const opacity = 1 - smooth(5_460, 6_200, time);
  if (opacity <= 0) return;
  const warmth: Color = [255, 118, 45];
  const ionBlue: Color = [38, 131, 254];

  context.globalAlpha = opacity;
  glow(context, centerX, centerY, radius * 3.9 + 17,
    color(warmth, ionBlue, cool, .47), color(warmth, ionBlue, cool, .16));
  const body = context.createRadialGradient(
    centerX - radius * .16, centerY - radius * .22, 0, centerX, centerY, radius,
  );
  body.addColorStop(0, color([255, 243, 204], [156, 229, 255], cool));
  body.addColorStop(.6, color([255, 180, 81], [57, 151, 253], cool));
  body.addColorStop(.94, color([206, 66, 23], [17, 72, 185], cool, .72));
  body.addColorStop(1, color(warmth, ionBlue, cool, .18));
  context.fillStyle = body;
  disc(context, centerX, centerY, radius);
  context.globalAlpha = 1;
}

function paintAtom(context: CanvasRenderingContext2D, time: number) {
  const emergence = smooth(3_250, 4_190, time);
  const convergence = smooth(5_360, 6_270, time);
  const opacity = emergence * (1 - convergence);
  if (opacity <= 0) return;

  const scale = mix(.66 + emergence * .34, .16, convergence);
  glow(context, centerX, centerY, 195 * scale, `rgba(38,135,255,${opacity * .24})`, `rgba(20,76,160,${opacity * .16})`);
  context.save();
  context.translate(centerX, centerY);
  context.scale(scale, scale);
  context.globalAlpha = opacity * .32;
  context.strokeStyle = '#376e9d';
  context.lineWidth = .75;
  context.beginPath();
  context.arc(0, 0, 94, 0, turn);
  context.stroke();

  for (const { tilt, radiusX, radiusY, origin, speed, tone } of orbits) {
    context.save();
    context.rotate(tilt + convergence * 1.4);
    context.strokeStyle = tone;
    context.lineWidth = .8;
    context.globalAlpha = opacity * .38;
    context.beginPath();
    context.ellipse(0, 0, radiusX, radiusY, 0, 0, turn);
    context.stroke();

    const phase = origin + (time - 3_250) * speed;
    const direction = Math.sign(speed);
    context.lineCap = 'round';
    for (let segment = 3; segment >= 0; segment--) {
      const tip = phase - segment * .13 * direction;
      context.globalAlpha = opacity * (.79 - segment * .16);
      context.lineWidth = 1.7 - segment * .27;
      context.beginPath();
      context.ellipse(0, 0, radiusX, radiusY, 0, tip - .15 * direction, tip, direction < 0);
      context.stroke();
    }
    const x = radiusX * Math.cos(phase);
    const y = radiusY * Math.sin(phase);
    context.fillStyle = tone;
    context.globalAlpha = opacity * .18;
    disc(context, x, y, 6.8);
    context.fillStyle = '#e3fcff';
    context.globalAlpha = opacity;
    disc(context, x, y, 2.7);
    context.restore();
  }
  context.fillStyle = '#c2f5ff';
  context.globalAlpha = opacity * .95;
  disc(context, 0, 0, 5.8);
  context.restore();
}

function paint(context: CanvasRenderingContext2D, time: number) {
  const approach = smooth(1_320, 3_230, time);
  const retreat = smooth(3_230, 4_350, time);
  const reveal = smooth(5_380, 6_640, time);
  context.fillStyle = '#03070e';
  context.fillRect(0, 0, width, height);
  paintStars(context, time, approach, retreat);
  paintSun(context, time, approach, retreat);
  paintAtom(context, time);
  if (reveal > 0) {
    glow(context, centerX, centerY, 212, `rgba(30,101,141,${reveal * .23})`, `rgba(17,51,87,${reveal * .19})`);
  }
}

export default function CinematicIntro({ onFinish }: { onFinish: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const lockup = useRef<HTMLDivElement>(null);
  const finishIntro = useEffectEvent(onFinish);

  useEffect(() => {
    const surface = canvas.current;
    const brand = lockup.current;
    if (!surface || !brand) return;

    surface.width = width;
    surface.height = height;
    const context = surface.getContext('2d', { alpha: false });
    if (!context) {
      finishIntro();
      return;
    }

    let elapsed = 0;
    let lastFrame: number | undefined;
    let lastPaint = -frameInterval;
    let pendingFrame = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(pendingFrame);
      finishIntro();
    };

    const frame = (now: number) => {
      pendingFrame = 0;
      elapsed += lastFrame === undefined ? 0 : now - lastFrame;
      lastFrame = now;
      if (elapsed >= duration) {
        finish();
        return;
      }
      if (elapsed - lastPaint >= frameInterval - 1 && elapsed < 7_200) {
        paint(context, elapsed);
        if (elapsed >= 5_360) {
          brand.style.setProperty('--ion-glyph-reveal', String(smooth(5_360, 6_420, elapsed)));
          brand.style.setProperty('--ion-name-reveal', String(smooth(5_960, 6_700, elapsed)));
          brand.style.setProperty('--ion-tagline-reveal', String(smooth(6_230, 7_150, elapsed)));
        }
        lastPaint = elapsed;
      }
      pendingFrame = requestAnimationFrame(frame);
    };

    function updateVisibility() {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
      lastFrame = undefined;
      if (!document.hidden && !finished) pendingFrame = requestAnimationFrame(frame);
    }

    surface.addEventListener('contextlost', finish);
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => {
      finished = true;
      cancelAnimationFrame(pendingFrame);
      document.removeEventListener('visibilitychange', updateVisibility);
      surface.removeEventListener('contextlost', finish);
      surface.width = 0;
      surface.height = 0;
    };
  }, []);

  return <div className="ion-cinematic" data-testid="onboarding-intro" aria-hidden="true">
    <canvas ref={canvas} />
    <div className="ion-cinematic-lockup" ref={lockup}>
      <Icon name="logo" size={104}/>
      <div className="ion-cinematic-name">ION <span>IDE</span></div>
      <p>Write code. Understand errors. Learn offline.</p>
    </div>
  </div>;
}
