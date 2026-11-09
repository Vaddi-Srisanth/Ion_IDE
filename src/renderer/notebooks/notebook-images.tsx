/// <reference lib="esnext.typedarrays" />
import { useEffect, useMemo, useRef, useState } from 'react';
import { notebookText } from '../../shared/notebook-format';

const maxEncoded = Math.ceil(4 * 1024 * 1024 / 3) * 4;
const maxPixels = 8_000_000;
const maxSvg = 512 * 1024;
const svgNamespace = 'http://www.w3.org/2000/svg';
const xlinkNamespace = 'http://www.w3.org/1999/xlink';

type Dimensions = { width: number; height: number };
type ImageSource = Dimensions & { mime: string; data: string; base64: boolean };

function boundedDimensions(width: number, height: number): Dimensions | undefined {
  if (width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= maxPixels) {
    return { width, height };
  }
}

function pngDimensions(header: string): Dimensions | undefined {
  if (!header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR') return;
  const integer = (start: number) => header.charCodeAt(start) * 2 ** 24 + header.charCodeAt(start + 1) * 2 ** 16
    + header.charCodeAt(start + 2) * 256 + header.charCodeAt(start + 3);
  return boundedDimensions(integer(16), integer(20));
}

function jpegDimensions(header: string): Dimensions | undefined {
  const byte = (offset: number) => header.charCodeAt(offset);
  const short = (offset: number) => byte(offset) * 256 + byte(offset + 1);
  if (short(0) !== 0xffd8) return;
  let offset = 2;
  while (offset < header.length - 8 && byte(offset) === 0xff) {
    while (byte(offset) === 0xff) offset++;
    const marker = byte(offset++);
    if (marker === 0xda || marker === 0xd9) return;
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
    const size = short(offset);
    if (size < 2 || !Number.isFinite(size)) return;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 8) {
      return boundedDimensions(short(offset + 5), short(offset + 3));
    }
    offset += size;
  }
}

function raster(mime: string, value: unknown): ImageSource | undefined {
  const text = notebookText(value, maxEncoded + 8193);
  if (!text || text.length > maxEncoded + 8192) return;
  const data = /\s/.test(text) ? text.replace(/\s+/g, '') : text;
  if (data.length > maxEncoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  try {
    // JPEGs may contain an EXIF segment before the size marker.
    const header = atob(data.slice(0, mime === 'image/png' ? 32 : 87_392));
    const size = mime === 'image/png' ? pngDimensions(header) : jpegDimensions(header);
    if (size) return { ...size, mime, data, base64: true };
  } catch {
    return undefined;
  }
}

const svgElements = new Set(['svg', 'g', 'defs', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle',
  'ellipse', 'text', 'tspan', 'title', 'desc', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'use']);
const svgGeometry = new Set(['id', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'dx', 'dy', 'cx', 'cy', 'r', 'rx', 'ry',
  'fx', 'fy', 'fr', 'd', 'points', 'width', 'height', 'viewBox', 'transform', 'gradientTransform', 'gradientUnits',
  'clipPathUnits', 'spreadMethod', 'offset', 'preserveAspectRatio', 'pathLength']);
const svgPresentation = new Set(['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity',
  'clip-path', 'clip-rule', 'stop-color', 'stop-opacity', 'font', 'font-family', 'font-size', 'font-weight',
  'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline']);
const svgPrimitive = new Set(['path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']);
const fragment = /^#[\w:.-]{1,120}$/;

function presentationValue(value: string): boolean {
  return /^url\(\s*#[\w:.-]{1,120}\s*\)$/i.test(value)
    || !/url|var\s*\(|expression|[<>@\\;]/i.test(value) && value.length <= 256;
}

function sanitizeSvg(value: unknown): ImageSource | undefined {
  const text = notebookText(value, maxSvg + 1);
  if (!text || text.length > maxSvg) return;
  // Matplotlib emits a public SVG 1.1 doctype. Discard it before XML parsing.
  const markup = text.replace(/<!DOCTYPE\s+svg\s+PUBLIC\s+"[^"<>]*"\s+"[^"<>]*"\s*>/i, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) return;
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== svgNamespace || doc.querySelector('parsererror')) return;

  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const length = (name: string) => {
    const attribute = root.getAttribute(name) ?? '';
    if (!/^\d+(?:\.\d+)?(?:px|pt)?$/.test(attribute)) return NaN;
    return Number.parseFloat(attribute) * (attribute.endsWith('pt') ? 4 / 3 : 1);
  };
  const size = boundedDimensions(length('width'), length('height'))
    ?? (viewBox?.length === 4 ? boundedDimensions(viewBox[2], viewBox[3]) : undefined);
  if (!size) return;
  const work: { node: Element; depth: number }[] = [{ node: root, depth: 0 }];
  const references: { node: Element; target: string }[] = [];
  const ids = new Set<string>();
  const primitives = new Set<string>();
  let visited = 0;
  while (work.length) {
    const { node, depth } = work.pop()!;
    if (++visited > 8000 || depth > 64) return;
    for (const attribute of [...node.attributes]) {
      const { localName, namespaceURI, value: raw } = attribute;
      if (localName === 'href' && (namespaceURI === null || namespaceURI === xlinkNamespace) && node.localName === 'use' && fragment.test(raw)) {
        references.push({ node, target: raw.slice(1) });
      } else if (localName === 'style' && namespaceURI === null) {
        const declarations = raw.slice(0, 2048).split(';').flatMap((entry) => {
          const separator = entry.indexOf(':');
          const property = entry.slice(0, separator).trim();
          const setting = entry.slice(separator + 1).trim();
          return separator >= 0 && svgPresentation.has(property) && presentationValue(setting) ? [`${property}:${setting}`] : [];
        });
        if (declarations.length) node.setAttribute('style', declarations.join(';'));
        else node.removeAttributeNode(attribute);
        continue;
      } else if (namespaceURI === null && (svgGeometry.has(localName) || svgPresentation.has(localName) && presentationValue(raw))) {
        continue;
      }
      node.removeAttributeNode(attribute);
    }
    const id = node.getAttribute('id');
    if (id) {
      if (ids.has(id)) return;
      ids.add(id);
      if (svgPrimitive.has(node.localName)) primitives.add(id);
    }
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE && (child as Element).namespaceURI === svgNamespace
        && svgElements.has((child as Element).localName)) work.push({ node: child as Element, depth: depth + 1 });
      else if (child.nodeType !== Node.TEXT_NODE) child.remove();
    }
  }
  // Limit <use> to local primitive shapes so recursive references cannot multiply work.
  for (const { node, target } of references) if (primitives.has(target)) node.setAttribute('href', '#' + target);
  root.setAttribute('width', String(Math.round(size.width)));
  root.setAttribute('height', String(Math.round(size.height)));
  return { ...size, mime: 'image/svg+xml', data: new XMLSerializer().serializeToString(root), base64: false };
}

export const notebookImageMimes = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;
export type NotebookImageMime = typeof notebookImageMimes[number];

function isStaticPng(bytes: Uint8Array<ArrayBuffer>): boolean {
  const view = new DataView(bytes.buffer);
  let offset = 8;
  while (offset + 12 <= view.byteLength) {
    const size = view.getUint32(offset);
    if (size > view.byteLength - offset - 12) return false;
    const type = view.getUint32(offset + 4);
    if (type === 0x6163544c || type === 0x6663544c || type === 0x66644154) return false; // APNG control/frame chunks.
    if (type === 0x49444154) return true; // IDAT follows animation control in APNG.
    offset += 12 + size;
  }
  return false;
}

export function NotebookImage({ mime, value, alt }: { mime: NotebookImageMime; value: unknown; alt: string }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [nearby, setNearby] = useState(false);
  const [url, setUrl] = useState<string>();
  const image = useMemo(() => mime === 'image/svg+xml' ? sanitizeSvg(value) : raster(mime, value), [mime, value]);
  const [failedImage, setFailedImage] = useState<ImageSource>();
  const failed = image === failedImage;

  useEffect(() => {
    const element = holder.current;
    if (!element || !image || failed) return;
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), { rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [image, failed]);

  useEffect(() => {
    setUrl(undefined);
    if (!nearby || !image || failed) return;
    try {
      const bytes = image.base64 ? Uint8Array.fromBase64(image.data) : image.data;
      if (image.mime === 'image/png' && typeof bytes !== 'string' && !isStaticPng(bytes)) {
        setFailedImage(image);
        return;
      }
      const localUrl = URL.createObjectURL(new Blob([bytes], { type: image.mime }));
      setUrl(localUrl);
      return () => URL.revokeObjectURL(localUrl);
    } catch {
      setFailedImage(image);
    }
  }, [image, nearby, failed]);

  if (!image || failed) return <span className="notebook-muted">This saved image could not be previewed within the image limits.</span>;
  const width = Math.min(760, image.width, 400 * image.width / image.height);
  return <span ref={holder} className="notebook-image" style={{ width, aspectRatio: `${image.width} / ${image.height}` }}>
    {url && <img data-testid="notebook-image" src={url} alt={alt} decoding="async" draggable={false}
      onError={() => setFailedImage(image)}/>}
  </span>;
}
