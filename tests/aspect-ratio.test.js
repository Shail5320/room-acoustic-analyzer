import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAspectRatio,
  getExactAspectRatio,
  aspectCorrectedDistance,
  formatAspectRatio,
} from '../src/ui/coordinates.js';
import { SessionModel } from '../src/ui/session-model.js';
import {
  StorageService,
  MemoryStorageAdapter,
  migrateSession,
} from '../src/store/storage.js';

test('AspectRatio - Exact numeric ratio calculation with and without room dimensions', () => {
  // 1. With room dimensions (Length maps to X width, Width maps to Y height)
  // 5m length x 3m width -> exact ratio 5/3 = 1.6666666666666667
  const sessionWithDims = {
    aspectRatio: '1.67:1', // old rounded string
    roomDimensions: {
      lengthM: 5.0,
      widthM: 3.0,
      heightM: 2.5,
    },
  };
  const exactR = getExactAspectRatio(sessionWithDims);
  assert.equal(exactR, 5.0 / 3.0);
  assert.notEqual(exactR, 1.67, 'Must use exact width/height ratio 5/3 rather than rounded 1.67');

  // 2. Without room dimensions, but with stored numeric ratio
  const sessionNumeric = {
    aspectRatio: 16 / 9,
    roomDimensions: null,
  };
  assert.equal(getExactAspectRatio(sessionNumeric), 16 / 9);

  // 3. Without room dimensions, but with old string preset
  const sessionString = {
    aspectRatio: '4:3',
    roomDimensions: null,
  };
  assert.equal(getExactAspectRatio(sessionString), 4 / 3);

  // 4. Fallback when neither is present
  assert.equal(getExactAspectRatio({}), 4 / 3);
});

test('AspectRatio - Heatmap distance calculation uses exact numeric ratio R = width/height', () => {
  // Room: 6m length (X) by 3m width (Y) -> exact R = 6 / 3 = 2.0
  const session = {
    aspectRatio: 2.0,
    roomDimensions: {
      lengthM: 6.0,
      widthM: 3.0,
    },
  };

  const pOrigin = { x: 0.0, y: 0.0 };
  const pHorizontal = { x: 0.5, y: 0.0 }; // 0.5 * 6m = 3m physical distance
  const pVertical = { x: 0.0, y: 1.0 };   // 1.0 * 3m = 3m physical distance

  // Both points are physically 3 metres from origin
  const dHoriz = aspectCorrectedDistance(pOrigin, pHorizontal, session);
  const dVert = aspectCorrectedDistance(pOrigin, pVertical, session);

  // d = sqrt((dx * R)^2 + dy^2)
  // For pHorizontal: sqrt((0.5 * 2.0)^2 + 0^2) = sqrt(1^2) = 1.0
  // For pVertical:   sqrt(0 + 1.0^2) = 1.0
  assert.equal(dHoriz, 1.0);
  assert.equal(dVert, 1.0);
  assert.equal(dHoriz, dVert, 'Equal physical distances must yield equal aspect-corrected distances');

  // Verification against uncorrected distance which would falsely report pHorizontal as closer (0.5 vs 1.0)
  const uncorrectedHoriz = Math.hypot(pHorizontal.x - pOrigin.x, pHorizontal.y - pOrigin.y);
  assert.equal(uncorrectedHoriz, 0.5, 'Uncorrected distance distorts spatial relationship');

  // Comparison between rounded string ratio 1.67 vs exact ratio 5/3 (5m x 3m room)
  const sessionExact = {
    aspectRatio: 5 / 3,
    roomDimensions: { lengthM: 5.0, widthM: 3.0 },
  };
  const sessionRounded = {
    aspectRatio: 1.67,
    roomDimensions: null,
  };

  const p1 = { x: 0.2, y: 0.3 };
  const p2 = { x: 0.8, y: 0.7 };
  const dExact = aspectCorrectedDistance(p1, p2, sessionExact);
  const dRounded = aspectCorrectedDistance(p1, p2, sessionRounded);

  const expectedExact = Math.sqrt(((0.8 - 0.2) * (5 / 3)) ** 2 + (0.7 - 0.3) ** 2);
  assert.equal(dExact, expectedExact);
  assert.notEqual(dExact, dRounded, 'Exact calculation must avoid rounding errors from string representation');
});

test('AspectRatio - Migration on load in SessionModel', () => {
  const model = new SessionModel();

  // 1. Load old session with rounded string "1.67:1" and dimensions
  const oldSessionWithDims = {
    id: 's_old_1',
    name: 'Old Session With Dims',
    aspectRatio: '1.67:1',
    roomDimensions: {
      unit: 'metres',
      lengthM: 5.0,
      widthM: 3.0,
      heightM: 2.5,
    },
    measurements: [],
  };

  model.loadSession(oldSessionWithDims);
  assert.equal(typeof model.aspectRatio, 'number', 'aspectRatio must be migrated to a number');
  assert.equal(model.aspectRatio, 5.0 / 3.0, 'Must be migrated to exact numeric ratio from dimensions');
  assert.equal(model.exactAspectRatio, 5.0 / 3.0);
  assert.equal(model.toJSON().aspectRatio, 5.0 / 3.0);

  // 2. Load old session with rounded string "1.67:1" without dimensions
  const oldSessionNoDims = {
    id: 's_old_2',
    name: 'Old Session No Dims',
    aspectRatio: '1.67:1',
    roomDimensions: null,
    measurements: [],
  };

  model.loadSession(oldSessionNoDims);
  assert.equal(typeof model.aspectRatio, 'number');
  assert.equal(model.aspectRatio, 1.67);

  // 3. Load old session with preset string "4:3"
  const oldSessionPreset = {
    id: 's_old_3',
    name: 'Old Session 4:3',
    aspectRatio: '4:3',
    roomDimensions: null,
    measurements: [],
  };

  model.loadSession(oldSessionPreset);
  assert.equal(typeof model.aspectRatio, 'number');
  assert.equal(model.aspectRatio, 4 / 3);

  // 4. Constructor initialization also migrates old formats
  const modelFromOldState = new SessionModel({
    aspectRatio: '16:9',
    roomDimensions: null,
  });
  assert.equal(typeof modelFromOldState.aspectRatio, 'number');
  assert.equal(modelFromOldState.aspectRatio, 16 / 9);

  // 5. aspectCorrectedDistance on SessionModel instance
  const dist = modelFromOldState.aspectCorrectedDistance({ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 });
  const expectedDist = Math.sqrt(((0.4) * (16 / 9)) ** 2 + 0.4 ** 2);
  assert.equal(dist, expectedDist);
});

test('AspectRatio - Migration on load in StorageService', async () => {
  const adapter = new MemoryStorageAdapter();
  const storage = new StorageService(adapter);

  // Manually put raw old sessions with string aspect ratios into adapter (simulating legacy database)
  await adapter.saveSession({
    id: 'legacy_dim',
    name: 'Legacy Dimensions Session',
    aspectRatio: '1.67:1',
    roomDimensions: {
      unit: 'metres',
      lengthM: 10.0,
      widthM: 6.0,
      heightM: 3.0,
    },
    measurements: [],
  });

  await adapter.saveSession({
    id: 'legacy_str',
    name: 'Legacy String Preset Session',
    aspectRatio: '4:3',
    roomDimensions: null,
    measurements: [],
  });

  // 1. Loading legacy session with dimensions via storage.get() migrates aspectRatio to exact number
  const loadedDim = await storage.get('legacy_dim');
  assert.equal(typeof loadedDim.aspectRatio, 'number');
  assert.equal(loadedDim.aspectRatio, 10.0 / 6.0); // 1.6666666666666667, not 1.67

  // 2. Loading legacy session without dimensions via storage.get() migrates aspectRatio to parsed number
  const loadedStr = await storage.get('legacy_str');
  assert.equal(typeof loadedStr.aspectRatio, 'number');
  assert.equal(loadedStr.aspectRatio, 4 / 3);

  // 3. Listing legacy sessions also returns migrated numeric ratios
  const list = await storage.list();
  const listDim = list.find((s) => s.id === 'legacy_dim');
  const listStr = list.find((s) => s.id === 'legacy_str');
  assert.equal(typeof listDim.aspectRatio, 'number');
  assert.equal(listDim.aspectRatio, 10.0 / 6.0);
  assert.equal(typeof listStr.aspectRatio, 'number');
  assert.equal(listStr.aspectRatio, 4 / 3);

  // 4. Standalone migrateSession function
  const legacyObj = { aspectRatio: '16:9', roomDimensions: null };
  migrateSession(legacyObj);
  assert.equal(legacyObj.aspectRatio, 16 / 9);
});
