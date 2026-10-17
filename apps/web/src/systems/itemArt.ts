// Flat item illustrations, palette only. Drawn for a paper background.

const INK = "#121212";
const WOOD = "#3A2A1E";
const PAPER = "#F2EBDD";
const ORANGE = "#FF5A1F";
const RED = "#C2362B";
const GREY = "#8A867E";

function dialHoles(): string {
  let out = "";
  for (let i = 0; i < 9; i += 1) {
    const a = ((-60 + i * 30) * Math.PI) / 180;
    const x = 60 + Math.cos(a) * 13.5;
    const y = 80 + Math.sin(a) * 13.5;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${INK}"/>`;
  }
  return out;
}

const ART: Record<string, string> = {
  compass: `
    <circle cx="60" cy="16" r="7" fill="none" stroke="${INK}" stroke-width="4"/>
    <rect x="53" y="21" width="14" height="8" rx="2" fill="${INK}"/>
    <circle cx="60" cy="66" r="42" fill="${ORANGE}" stroke="${INK}" stroke-width="4"/>
    <circle cx="60" cy="66" r="31" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <path d="M60 37v7M60 88v7M31 66h7M82 66h7" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
    <path d="M60 66 L53 63 L60 40 L67 63 Z" fill="${RED}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M60 66 L53 69 L60 92 L67 69 Z" fill="${INK}"/>
    <circle cx="60" cy="66" r="4" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>`,
  robot: `
    <line x1="60" y1="12" x2="60" y2="24" stroke="${INK}" stroke-width="4"/>
    <circle cx="60" cy="10" r="6" fill="${RED}" stroke="${INK}" stroke-width="3"/>
    <rect x="34" y="24" width="52" height="34" rx="6" fill="${GREY}" stroke="${INK}" stroke-width="4"/>
    <circle cx="48" cy="41" r="7" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <circle cx="72" cy="41" r="7" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <circle cx="49" cy="42" r="2.6" fill="${INK}"/>
    <circle cx="73" cy="42" r="2.6" fill="${INK}"/>
    <path d="M30 34 h4 M86 34 h4" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
    <rect x="16" y="64" width="12" height="28" rx="5" fill="${GREY}" stroke="${INK}" stroke-width="3"/>
    <rect x="92" y="64" width="12" height="28" rx="5" fill="${GREY}" stroke="${INK}" stroke-width="3"/>
    <rect x="28" y="60" width="64" height="42" rx="4" fill="${GREY}" stroke="${INK}" stroke-width="4"/>
    <rect x="40" y="68" width="40" height="16" fill="${ORANGE}" stroke="${INK}" stroke-width="3"/>
    <path d="M46 92 h28" stroke="${INK}" stroke-width="3" stroke-dasharray="4 4"/>
    <rect x="38" y="102" width="14" height="12" fill="${INK}"/>
    <rect x="68" y="102" width="14" height="12" fill="${INK}"/>
    <path d="M92 50 h14 M106 42 v16" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`,
  phone: `
    <path d="M12 46 C12 30 30 21 60 21 C90 21 108 30 108 46 L95 51 C92 42 80 37 60 37 C40 37 28 42 25 51 Z" fill="${ORANGE}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M26 106 L35 60 C40 53 80 53 85 60 L94 106 Z" fill="${ORANGE}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
    <circle cx="60" cy="80" r="20" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    ${dialHoles()}
    <circle cx="60" cy="80" r="6.5" fill="${ORANGE}" stroke="${INK}" stroke-width="2"/>
    <path d="M78 66 L84 60" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
  camera: `
    <rect x="24" y="26" width="20" height="11" fill="${GREY}" stroke="${INK}" stroke-width="3"/>
    <rect x="47" y="28" width="8" height="9" fill="${ORANGE}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M58 46 L84 52 L84 82 L58 88 Z" fill="${GREY}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M66 48v38 M75 50v34" stroke="${INK}" stroke-width="2"/>
    <rect x="84" y="46" width="14" height="42" fill="${WOOD}" stroke="${INK}" stroke-width="3"/>
    <circle cx="100" cy="67" r="11" fill="${INK}"/>
    <circle cx="100" cy="67" r="5" fill="${PAPER}"/>
    <rect x="14" y="36" width="44" height="62" rx="4" fill="${WOOD}" stroke="${INK}" stroke-width="4"/>
    <path d="M14 52 h44 M14 84 h44" stroke="${GREY}" stroke-width="2" stroke-dasharray="3 3"/>
    <rect x="24" y="58" width="24" height="18" fill="${PAPER}" stroke="${INK}" stroke-width="2.5"/>`,
};

export function itemSvg(art: string, label: string): string {
  const body = ART[art] ?? ART.compass ?? "";
  return `<svg class="item-art" viewBox="0 0 120 120" role="img" aria-label="${label.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}">${body}</svg>`;
}
