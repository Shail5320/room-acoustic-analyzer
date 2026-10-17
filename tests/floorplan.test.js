import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRoomBounds,
  pixelToRelative,
  relativeToPixel,
  parseAspectRatio,
} from '../src/ui/coordinates.js';
import {
  SessionModel,
  generateFakeMeasurementData,
  OCTAVE_BANDS,
} from '../src/ui/session-model.js';

test('Coordinate transform: parseAspectRatio handles strings, presets, and floats', () => {
  assert.equal(parseAspectRatio('4:3'), 4 / 3);
  assert.equal(parseAspectRatio('16:9'), 16 / 9);
  assert.equal(parseAspectRatio('1:1'), 1.0);
  assert.equal(parseAspectRatio('3/2'), 1.5);
  assert.equal(parseAspectRatio(1.777), 1.777);
  assert.equal(parseAspectRatio('invalid'), 4 / 3);
});

test('Coordinate transform: getRoomBounds respects aspect ratio and centers within viewport', () => {
  const canvasWidth = 800;
  const canvasHeight = 600;
  const padding = 20;

  // At 4:3 with 800x600 canvas (avail 760x560):
  // 760/560 = 1.357 > 1.333 -> height constrained (height=560, width=560*4/3=746.666)
  const bounds43 = getRoomBounds({ canvasWidth, canvasHeight, aspectRatio: '4:3', padding });
  assert.ok(Math.abs(bounds43.width / bounds43.height - 4 / 3) < 1e-6);
  assert.equal(bounds43.y, padding);
  assert.equal(bounds43.height, 560);
  assert.ok(bounds43.x > padding); // Centered horizontally

  // At 1:1 with 800x600 canvas (avail 760x560):
  // 760/560 > 1.0 -> height constrained (height=560, width=560)
  const bounds11 = getRoomBounds({ canvasWidth, canvasHeight, aspectRatio: '1:1', padding });
  assert.equal(bounds11.width, 560);
  assert.equal(bounds11.height, 560);
  assert.equal(bounds11.x, padding + (760 - 560) / 2);

  // At 16:9 with 800x600 canvas (avail 760x560):
  // 16/9 = 1.777 > 1.357 -> width constrained (width=760, height=760/(16/9)=427.5)
  const bounds169 = getRoomBounds({ canvasWidth, canvasHeight, aspectRatio: '16:9', padding });
  assert.ok(Math.abs(bounds169.width / bounds169.height - 16 / 9) < 1e-6);
  assert.equal(bounds169.width, 760);
  assert.equal(bounds169.x, padding);
  assert.ok(bounds169.y > padding); // Centered vertically
});

test('Coordinate transform: bidirectional round-trip at 4:3, 16:9, and 1:1 aspect ratios', () => {
  const canvasWidth = 640;
  const canvasHeight = 480;
  const ratios = ['4:3', '16:9', '1:1'];
  const testPoints = [
    { rx: 0.0, ry: 0.0 },
    { rx: 1.0, ry: 1.0 },
    { rx: 0.5, ry: 0.5 },
    { rx: 0.25, ry: 0.75 },
    { rx: 0.82, ry: 0.13 },
  ];

  for (const ratio of ratios) {
    const roomBounds = getRoomBounds({ canvasWidth, canvasHeight, aspectRatio: ratio, padding: 15 });

    for (const pt of testPoints) {
      // Relative -> Pixel
      const pixel = relativeToPixel(pt.rx, pt.ry, roomBounds);
      assert.ok(pixel, `relativeToPixel failed for ratio ${ratio}`);
      assert.ok(pixel.x >= roomBounds.x && pixel.x <= roomBounds.x + roomBounds.width);
      assert.ok(pixel.y >= roomBounds.y && pixel.y <= roomBounds.y + roomBounds.height);

      // Pixel -> Relative (no clamp)
      const roundTrip = pixelToRelative(pixel.x, pixel.y, roomBounds, { clamp: false });
      assert.ok(roundTrip, `pixelToRelative failed for ratio ${ratio}`);
      assert.ok(
        Math.abs(roundTrip.x - pt.rx) < 1e-6,
        `X mismatch at ratio ${ratio}: expected ${pt.rx}, got ${roundTrip.x}`
      );
      assert.ok(
        Math.abs(roundTrip.y - pt.ry) < 1e-6,
        `Y mismatch at ratio ${ratio}: expected ${pt.ry}, got ${roundTrip.y}`
      );
    }
  }
});

test('Requirement 1 & 5: Taps outside room bounds return null; dragging clamps to [0, 1]', () => {
  const roomBounds = { x: 50, y: 50, width: 400, height: 300 };

  // Outside points (left, right, top, bottom)
  const outsidePoints = [
    { px: 10, py: 100 },
    { px: 460, py: 100 },
    { px: 100, py: 20 },
    { px: 100, py: 360 },
  ];

  for (const pt of outsidePoints) {
    // Tap outside (clamp = false) must return null
    const tapResult = pixelToRelative(pt.px, pt.py, roomBounds, { clamp: false });
    assert.equal(tapResult, null, `Tap outside at (${pt.px}, ${pt.py}) should return null`);

    // Drag outside (clamp = true) must clamp to [0, 1]
    const dragResult = pixelToRelative(pt.px, pt.py, roomBounds, { clamp: true });
    assert.ok(dragResult !== null, 'Drag should return clamped coords');
    assert.ok(dragResult.x >= 0.0 && dragResult.x <= 1.0);
    assert.ok(dragResult.y >= 0.0 && dragResult.y <= 1.0);
  }

  // Extreme drag clamps exactly to boundary
  const farLeftDrag = pixelToRelative(-100, 200, roomBounds, { clamp: true });
  assert.equal(farLeftDrag.x, 0.0);
  const farBottomDrag = pixelToRelative(200, 999, roomBounds, { clamp: true });
  assert.equal(farBottomDrag.y, 1.0);
});

test('Requirement 5: Changing aspect ratio preserves relative marker coordinates', () => {
  const session = new SessionModel({ aspectRatio: '4:3' });
  session.setSource(0.2, 0.4);
  session.addPendingMeasurement(0.6, 0.7);

  assert.equal(session.source.x, 0.2);
  assert.equal(session.source.y, 0.4);
  assert.equal(session.measurements[0].x, 0.6);
  assert.equal(session.measurements[0].y, 0.7);

  // Switch aspect ratio to 16:9
  session.setAspectRatio('16:9');
  assert.equal(session.aspectRatio, 16 / 9);
  assert.equal(session.aspectRatioString, '16:9');
  assert.equal(session.source.x, 0.2, 'Source relative X must remain unchanged');
  assert.equal(session.source.y, 0.4, 'Source relative Y must remain unchanged');
  assert.equal(session.measurements[0].x, 0.6, 'Measurement relative X must remain unchanged');
  assert.equal(session.measurements[0].y, 0.7, 'Measurement relative Y must remain unchanged');

  // Switch to 1:1
  session.setAspectRatio('1:1');
  assert.equal(session.source.x, 0.2);
  assert.equal(session.source.y, 0.4);
  assert.equal(session.measurements[0].x, 0.6);
  assert.equal(session.measurements[0].y, 0.7);
});

test('Requirement 2 & 4: Pending measurements, fake measurement generation, and tier diversity', () => {
  const session = new SessionModel();

  // Add pending measurement (position only)
  const p1 = session.addPendingMeasurement(0.3, 0.3);
  assert.equal(p1.id, 1);
  assert.equal(p1.status, 'pending');
  assert.equal(p1.bands, null);
  assert.equal(p1.fake, false);
  assert.equal(p1.timestamp, null);

  // Use DEV button to fill the pending point
  const filled = session.addOrFillDevMeasurement(p1.id);
  assert.equal(filled.id, 1);
  assert.equal(filled.status, 'measured');
  assert.equal(filled.fake, true);
  assert.ok(typeof filled.timestamp === 'number');
  assert.ok(typeof filled.pnrDb === 'number');
  assert.ok(typeof filled.dynamicRangeDb === 'number');
  assert.equal(filled.clipped, false);
  assert.ok(filled.bands);

  // Verify all 6 octave bands exist
  for (const band of OCTAVE_BANDS) {
    assert.ok(filled.bands[band], `Band ${band} must exist in measurement data`);
    assert.ok('t20' in filled.bands[band]);
    assert.ok('t30' in filled.bands[band]);
    assert.ok('edt' in filled.bands[band]);
    assert.ok('r2' in filled.bands[band]);
    assert.ok('used' in filled.bands[band]);
    assert.ok('tier' in filled.bands[band]);
  }

  // Verify Requirement 4: includes 'approximate' and 'invalid' bands
  const tiers = Object.values(filled.bands).map((b) => b.tier);
  assert.ok(tiers.includes('valid'), 'Must include valid tier bands');
  assert.ok(tiers.includes('approximate'), 'Must include approximate tier band');
  assert.ok(tiers.includes('invalid'), 'Must include invalid tier band');

  // DEV button when no pending points exist creates a new measured point
  const p2 = session.addOrFillDevMeasurement(null, 0.7, 0.8);
  assert.equal(p2.id, 2);
  assert.equal(p2.status, 'measured');
  assert.equal(p2.fake, true);
  assert.equal(p2.x, 0.7);
  assert.equal(p2.y, 0.8);
});

test('SessionModel: Movable source, repositioning, and deletion', () => {
  const session = new SessionModel();

  // Source placement and clamping
  session.setSource(-0.1, 1.2);
  assert.equal(session.source.x, 0.0);
  assert.equal(session.source.y, 1.0);

  session.setSource(0.4, 0.6);
  assert.equal(session.source.x, 0.4);
  assert.equal(session.source.y, 0.6);

  // Measurements
  const m1 = session.addPendingMeasurement(0.1, 0.2);
  const m2 = session.addPendingMeasurement(0.8, 0.9);
  assert.equal(session.measurements.length, 2);

  // Reposition measurement
  session.updateMeasurementPosition(m1.id, 0.15, 0.25);
  assert.equal(session.getMeasurement(m1.id).x, 0.15);
  assert.equal(session.getMeasurement(m1.id).y, 0.25);

  // Remove measurement
  session.removeMeasurement(m1.id);
  assert.equal(session.measurements.length, 1);
  assert.equal(session.measurements[0].id, m2.id);
  assert.equal(session.getMeasurement(m1.id), null);

  // Clear source
  session.clearSource();
  assert.equal(session.source, null);
});
