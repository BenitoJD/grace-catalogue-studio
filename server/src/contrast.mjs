// Contrast audit for the printed pages. The rule is simple and absolute:
// light ground takes dark text, dark ground takes light text. Every explicit
// text colour is checked against the colour actually behind it, including
// text sitting on a band or a scrim over a photograph.
import { parse } from 'node-html-parser';

const NAMED = {
  white: '#FFFFFF',
  black: '#000000',
  cream: '#F8F2E7',
  ivory: '#FFFFF0',
  transparent: null,
};

function parseColour(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') return null;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return [
      Number.parseInt(text[1] + text[1], 16),
      Number.parseInt(text[2] + text[2], 16),
      Number.parseInt(text[3] + text[3], 16),
    ];
  }
  if (/^#[0-9a-f]{6}$/.test(text)) {
    const value2 = Number.parseInt(text.slice(1), 16);
    return [(value2 >> 16) & 0xff, (value2 >> 8) & 0xff, value2 & 0xff];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => part.trim());
    const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
    const alpha = parts.length >= 4 ? Number.parseFloat(parts[3]) : 1;
    if (channels.some((channel) => Number.isNaN(channel))) return null;
    return { rgb: channels, alpha: Number.isNaN(alpha) ? 1 : alpha };
  }
  if (NAMED[text] !== undefined) {
    return NAMED[text] === null ? null : parseColour(NAMED[text]);
  }
  return null;
}

function toRgb(entry) {
  if (entry === null) return null;
  if (Array.isArray(entry)) return { rgb: entry, alpha: 1 };
  return entry;
}

function luminance([r, g, b]) {
  const channels = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function styleMap(element) {
  const style = element.getAttribute('style') ?? '';
  const map = {};
  for (const part of style.split(';')) {
    const index = part.indexOf(':');
    if (index === -1) continue;
    map[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return map;
}

function resolveVar(value, theme) {
  if (!value) return value;
  return value.replace(/var\(\s*--([a-z0-9-]+)\s*(?:,[^)]*)?\)/gi, (match, name) => {
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return theme?.[key] ?? match;
  });
}

function backgroundOf(element, theme) {
  // Walk up to the nearest ancestor that actually paints a background.
  let node = element;
  while (node && node.nodeType === 1) {
    const style = styleMap(node);
    const background = style.background ?? style['background-color'];
    if (background) {
      const resolved = resolveVar(background, theme);
      if (/gradient|url\(/i.test(resolved)) {
        return { kind: 'image', value: resolved };
      }
      const colour = toRgb(parseColour(resolved));
      if (colour && colour.alpha >= 0.6) {
        return { kind: 'solid', colour: colour.rgb };
      }
      if (colour) return { kind: 'image', value: resolved };
    }
    if (style.backgroundImage) {
      return { kind: 'image', value: style.backgroundImage };
    }
    if (node.tagName?.toLowerCase() === 'body' || node.tagName?.toLowerCase() === 'html') break;
    node = node.parentNode;
  }
  return { kind: 'solid', colour: parseColour(theme?.paper ?? '#F8F2E7') };
}

function hasText(element) {
  return element.childNodes.some(
    (child) => child.nodeType === 3 && String(child.text ?? '').trim().length > 1,
  );
}

/** All contrast problems in one page, in words the designer can fix. */
export function contrastIssues(pageHtml, theme) {
  const issues = [];
  let root;
  try {
    root = parse(pageHtml, { lowerCaseTagName: true, comment: false });
  } catch {
    return issues;
  }
  const visits = [];
  const walk = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (hasText(node)) visits.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  for (const element of visits) {
    const style = styleMap(element);
    if (!style.color) continue;
    const colour = toRgb(parseColour(resolveVar(style.color, theme)));
    if (!colour) continue;
    const background = backgroundOf(element, theme);
    const text = String(element.text ?? '').trim().slice(0, 48);
    if (background.kind === 'image') {
      // Text over a photograph or gradient must sit on a real scrim.
      issues.push(
        `the text "${text}" sits on a photograph or gradient without a solid scrim; put it on a band with a background colour so the words stay readable`,
      );
      continue;
    }
    const ratio = contrast(colour.rgb, background.colour);
    const size = Number.parseFloat(style['font-size'] ?? '');
    const large = Number.isFinite(size) && size >= 18;
    if (ratio < (large ? 3 : 4.5)) {
      issues.push(
        `the text "${text}" has too little contrast against its background (${ratio.toFixed(1)}:1); use dark text on a light ground or light text on a dark ground`,
      );
    }
  }
  return issues;
}
