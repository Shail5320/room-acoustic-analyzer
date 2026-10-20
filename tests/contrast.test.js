import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hexToRgb,
  getRelativeLuminance,
  getContrastRatio,
  parseCssThemeTokens,
} from '../src/ui/contrast.js';

const rootDir = process.cwd();
const cssPath = path.join(rootDir, 'style.css');

test('WCAG Math - Known relative luminances and contrast ratios', () => {
  // Pure black and white
  assert.equal(getRelativeLuminance(0, 0, 0), 0.0);
  assert.equal(getRelativeLuminance(255, 255, 255), 1.0);
  assert.equal(Math.round(getContrastRatio('#000000', '#ffffff')), 21);
  assert.equal(Math.round(getContrastRatio('#ffffff', '#000000')), 21);
  assert.equal(getContrastRatio('#ffffff', '#ffffff'), 1.0);

  // Hex parsing
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
  assert.deepEqual(hexToRgb('#123456'), [18, 52, 86]);
});

test('Design Tokens - Parse style.css directly and verify WCAG AA contrast (Light Theme)', () => {
  const css = fs.readFileSync(cssPath, 'utf-8');
  const { light } = parseCssThemeTokens(css);

  assert.ok(light['--bg-color'], 'Must have --bg-color');
  assert.ok(light['--surface-color'], 'Must have --surface-color');
  assert.ok(light['--text-primary'], 'Must have --text-primary');

  const bg = light['--bg-color'];
  const surface = light['--surface-color'];

  // WCAG AA requirement for normal body text is >= 4.5:1
  const textPrimarySurface = getContrastRatio(light['--text-primary'], surface);
  assert.ok(
    textPrimarySurface >= 4.5,
    `Light text-primary on surface must be >= 4.5:1 (got ${textPrimarySurface.toFixed(2)})`
  );

  const textSecondarySurface = getContrastRatio(light['--text-secondary'], surface);
  assert.ok(
    textSecondarySurface >= 4.5,
    `Light text-secondary on surface must be >= 4.5:1 (got ${textSecondarySurface.toFixed(2)})`
  );

  const primarySurface = getContrastRatio(light['--primary-color'], surface);
  assert.ok(
    primarySurface >= 4.5,
    `Light primary on surface must be >= 4.5:1 (got ${primarySurface.toFixed(2)})`
  );

  const successSurface = getContrastRatio(light['--success-color'], surface);
  assert.ok(
    successSurface >= 4.5,
    `Light success on surface must be >= 4.5:1 (got ${successSurface.toFixed(2)})`
  );

  const warningSurface = getContrastRatio(light['--warning-color'], surface);
  assert.ok(
    warningSurface >= 4.5,
    `Light warning on surface must be >= 4.5:1 (got ${warningSurface.toFixed(2)})`
  );

  const warningBg = getContrastRatio(light['--warning-color'], bg);
  assert.ok(
    warningBg >= 4.5,
    `Light warning on bg must be >= 4.5:1 (got ${warningBg.toFixed(2)})`
  );

  const dangerSurface = getContrastRatio(light['--danger-color'], surface);
  assert.ok(
    dangerSurface >= 4.5,
    `Light danger on surface must be >= 4.5:1 (got ${dangerSurface.toFixed(2)})`
  );

  // Button text on button background
  const onPrimaryContrast = getContrastRatio(light['--on-primary'], light['--primary-color']);
  assert.ok(
    onPrimaryContrast >= 4.5,
    `Light on-primary on primary-color must be >= 4.5:1 (got ${onPrimaryContrast.toFixed(2)})`
  );

  // Status badge text on container
  const badgeContrast = getContrastRatio(light['--primary-color'], light['--primary-container']);
  assert.ok(
    badgeContrast >= 4.5,
    `Light primary-color on primary-container must be >= 4.5:1 (got ${badgeContrast.toFixed(2)})`
  );
});

test('Design Tokens - Parse style.css directly and verify WCAG AA contrast (Dark Theme)', () => {
  const css = fs.readFileSync(cssPath, 'utf-8');
  const { dark } = parseCssThemeTokens(css);

  assert.ok(dark['--bg-color'], 'Must have dark --bg-color');
  assert.ok(dark['--surface-color'], 'Must have dark --surface-color');
  assert.ok(dark['--text-primary'], 'Must have dark --text-primary');

  const bg = dark['--bg-color'];
  const surface = dark['--surface-color'];

  const textPrimarySurface = getContrastRatio(dark['--text-primary'], surface);
  assert.ok(
    textPrimarySurface >= 4.5,
    `Dark text-primary on surface must be >= 4.5:1 (got ${textPrimarySurface.toFixed(2)})`
  );

  const textSecondarySurface = getContrastRatio(dark['--text-secondary'], surface);
  assert.ok(
    textSecondarySurface >= 4.5,
    `Dark text-secondary on surface must be >= 4.5:1 (got ${textSecondarySurface.toFixed(2)})`
  );

  const primarySurface = getContrastRatio(dark['--primary-color'], surface);
  assert.ok(
    primarySurface >= 4.5,
    `Dark primary on surface must be >= 4.5:1 (got ${primarySurface.toFixed(2)})`
  );

  const successSurface = getContrastRatio(dark['--success-color'], surface);
  assert.ok(
    successSurface >= 4.5,
    `Dark success on surface must be >= 4.5:1 (got ${successSurface.toFixed(2)})`
  );

  const warningSurface = getContrastRatio(dark['--warning-color'], surface);
  assert.ok(
    warningSurface >= 4.5,
    `Dark warning on surface must be >= 4.5:1 (got ${warningSurface.toFixed(2)})`
  );

  const dangerSurface = getContrastRatio(dark['--danger-color'], surface);
  assert.ok(
    dangerSurface >= 4.5,
    `Dark danger on surface must be >= 4.5:1 (got ${dangerSurface.toFixed(2)})`
  );

  // Button text on button background
  const onPrimaryContrast = getContrastRatio(dark['--on-primary'], dark['--primary-color']);
  assert.ok(
    onPrimaryContrast >= 4.5,
    `Dark on-primary on primary-color must be >= 4.5:1 (got ${onPrimaryContrast.toFixed(2)})`
  );

  // Status badge text on container
  const badgeContrast = getContrastRatio(dark['--primary-color'], dark['--primary-container']);
  assert.ok(
    badgeContrast >= 4.5,
    `Dark primary-color on primary-container must be >= 4.5:1 (got ${badgeContrast.toFixed(2)})`
  );
});

test('Accessibility - Motion preference rule in style.css', () => {
  const css = fs.readFileSync(cssPath, 'utf-8');
  assert.match(
    css,
    /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    'style.css must include prefers-reduced-motion media query'
  );
});
