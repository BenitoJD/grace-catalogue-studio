// Guaranteed-legible brand and contact panels. Each panel carries its own solid
// ground, the mark, the brand name and the studio contact lines, so it reads on
// cream, on a photograph or on a dark page without depending on what the model
// puts behind it.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BRAND = {
  name: 'Jacob Design Studio',
  phone: '+91 63740 43346',
  email: 'info.jacobdesignstudio@gmail.com',
  address: '26J, Rajjakamangalam Road, Chettikulam, Nagercoil 629001',
};

function markDataUri(templatesDir, white) {
  const file = path.join(templatesDir, 'assets', white ? 'jacob-mark-white.png' : 'jacob-mark.png');
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One brand panel as an SVG data URI. `variant` is dark or light; `contact`
 * adds the phone, email and address lines under the brand name.
 */
export function brandPlateDataUri(templatesDir, { variant = 'dark', contact = false } = {}) {
  const dark = variant !== 'light';
  const ground = dark ? '#173B44' : '#F8F2E7';
  const ink = dark ? '#F8F2E7' : '#1E2528';
  const mutedInk = dark ? '#CFE3EA' : '#5E6A6C';
  const keyline = dark ? '#B98A55' : '#B98A55';
  const mark = markDataUri(templatesDir, dark);
  const height = contact ? 196 : 104;
  const lines = contact
    ? `
    <text x="150" y="112" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="${mutedInk}">${escapeXml(BRAND.phone)}</text>
    <text x="150" y="138" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="${mutedInk}">${escapeXml(BRAND.email)}</text>
    <text x="150" y="164" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="${mutedInk}">${escapeXml(BRAND.address)}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="${height}" viewBox="0 0 620 ${height}">
  <rect x="1" y="1" width="618" height="${height - 2}" rx="10" fill="${ground}" stroke="${keyline}" stroke-width="2"/>
  <image href="${mark}" x="26" y="22" width="96" height="${contact ? 96 : 60}" preserveAspectRatio="xMidYMid meet"/>
  <text x="150" y="${contact ? 62 : 52}" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="bold" letter-spacing="2" fill="${ink}">${escapeXml(BRAND.name.toUpperCase())}</text>
  <text x="150" y="${contact ? 88 : 76}" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="4" fill="${mutedInk}">INTERIORS · NAGERCOIL</text>
  ${lines}
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** All four tokens the designer can place. */
export function brandPlateTokens(templatesDir) {
  return {
    brandPlateDark: brandPlateDataUri(templatesDir, { variant: 'dark' }),
    brandPlateLight: brandPlateDataUri(templatesDir, { variant: 'light' }),
    contactPlateDark: brandPlateDataUri(templatesDir, { variant: 'dark', contact: true }),
    contactPlateLight: brandPlateDataUri(templatesDir, { variant: 'light', contact: true }),
  };
}
