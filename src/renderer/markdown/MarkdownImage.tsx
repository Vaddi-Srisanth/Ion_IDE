import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownVisibility } from './visibility';

const readLimit = 3;
const pendingReads = new Set<() => void>();
let reading = 0;

function queueRead(read: () => Promise<void>): () => void {
  const begin = () => {
    reading++;
    void read().finally(() => {
      reading--;
      const next = pendingReads.values().next().value;
      if (next) { pendingReads.delete(next); next(); }
    });
  };
  if (reading < readLimit) begin();
  else pendingReads.add(begin);
  return () => { pendingReads.delete(begin); };
}

export function MarkdownImage({ path, workspacePath, href, alt }: { path: string; workspacePath: string; href: string; alt: string }) {
  const visible = useContext(MarkdownVisibility);
  const holder = useRef<HTMLSpanElement>(null);
  const [nearby, setNearby] = useState(false);
  const [image, setImage] = useState<{ key: string; url: string }>();
  const [size, setSize] = useState<{ key: string; width: number; height: number }>();
  const [failedKey, setFailedKey] = useState<string>();
  const key = `${workspacePath}\0${path}\0${href}`;
  const failed = failedKey === key;

  useLayoutEffect(() => { if (!visible) setNearby(false); }, [visible]);

  useEffect(() => {
    const element = holder.current;
    if (!visible || !element || failed) return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => { if (active) setNearby(entry.isIntersecting); },
      { root: element.closest('.markdown-preview'), rootMargin: '140px 0px' });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [failed, visible]);

  useEffect(() => {
    if (!visible || !nearby || failed) return;
    let active = true;
    let url: string | undefined;
    const unqueue = queueRead(async () => {
      try {
        const { bytes, mime } = await window.ion.markdown.readImage(path, href);
        if (!active) return;
        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setImage({ key, url });
      } catch { if (active) setFailedKey(key); }
    });
    return () => {
      active = false;
      unqueue();
      if (url) URL.revokeObjectURL(url);
      setImage((current) => current?.url === url ? undefined : current);
    };
  }, [failed, href, key, nearby, path, visible]);

  const url = visible && nearby && !failed && image?.key === key ? image.url : undefined;
  const dimensions = size?.key === key && !failed ? { width: size.width, aspectRatio: `${size.width} / ${size.height}` } : undefined;
  return <span ref={holder} className="markdown-image" style={dimensions}>
    {url ? <img src={url} alt={alt} decoding="async" draggable={false}
      onLoad={({ currentTarget }) => setSize({ key, width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })}
      onError={() => setFailedKey(key)}/> : <span className="markdown-image-note">{alt}</span>}
  </span>;
}
