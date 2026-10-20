/**
 * src/ui/contrast.js — WCAG 2.1 Contrast Ratio Calculator and CSS Token Parser.
 *
 * Implements:
 *   - Hex to sRGB conversion and relative luminance (per WCAG 2.1 definition:
 *     L = 0.2126*R + 0.7152*G + 0.0722*B where non-linear sRGB values are gamma-expanded).
 *   - Contrast ratio calculation: (L1 + 0.05) / (L2 + 0.05).
 *   - Pure token parsing from CSS string for light mode (:root) and dark mode (@media prefers-color-scheme: dark).
 *   - Zero runtime dependencies, runs in browser and Node.js.
 */

/**
 * Convert 3- or 6-character hex color code to [r, g, b] array in [0, 255].
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') {
    throw new TypeError(`Invalid hex string: ${hex}`);
  }
  let clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  if (clean.length !== 6) {
    throw new Error(`Invalid hex color length: "${hex}"`);
  }
  const intVal = parseInt(clean, 16);
  if (Number.isNaN(intVal)) {
    throw new Error(`Failed to parse hex color: "${hex}"`);
  }
  return [(intVal >> 16) & 255, (intVal >> 8) & 255, intVal & 255];
}

/**
 * Compute WCAG 2.1 relative luminance of an sRGB color.
 * @param {number} r 0–255
 * @param {number} g 0–255
 * @param {number} b 0–255
 * @returns {number} Relative luminance in [0, 1]
 */
export function getRelativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((val) => {
    const s = val / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate the WCAG contrast ratio between two hex colors.
 * @param {string} hex1
 * @param {string} hex2
 * @returns {number} Ratio in [1, 21]
 */
export function getContrastRatio(hex1, hex2) {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  const l1 = getRelativeLuminance(...rgb1);
  const l2 = getRelativeLuminance(...rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Parse CSS variable tokens from a CSS string for both light and dark themes.
 *
 * @param {string} cssContent
 * @returns {{ light: Record<string, string>, dark: Record<string, string> }}
 */
export function parseCssThemeTokens(cssContent) {
  if (typeof cssContent !== 'string') {
    throw new TypeError('cssContent must be a string');
  }

  // Find root block (before any dark mode media queries)
  const rootMatch = cssContent.match(/:root\s*\{([^}]+)\}/);
  if (!rootMatch) {
    throw new Error('No :root rule found in CSS content');
  }

  // Find dark mode root block
  const darkMatch = cssContent.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]+)\}/);
  if (!darkMatch) {
    throw new Error('No dark mode prefers-color-scheme rule found in CSS content');
  }

  const parseVarBlock = (block) => {
    const tokens = {};
    const varRegex = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})/g;
    let match;
    while ((match = varRegex.exec(block)) !== null) {
      tokens[match[1]] = match[2];
    }
    return tokens;
  };

  return {
    light: parseVarBlock(rootMatch[1]),
    dark: parseVarBlock(darkMatch[1]),
  };
}
