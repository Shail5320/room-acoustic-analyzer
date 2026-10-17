import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StorageService,
  MemoryStorageAdapter,
  generateSessionId,
} from '../src/store/storage.js';
import { generateFakeMeasurementData } from '../src/ui/session-model.js';

test('Storage - generateSessionId creates unique string identifiers', () => {
  const id1 = generateSessionId();
  const id2 = generateSessionId();
  assert.ok(id1.startsWith('session_'));
  assert.notEqual(id1, id2);
});

test('Storage - Save, load, list, and delete round-trip with in-memory adapter', async () => {
  const adapter = new MemoryStorageAdapter();
  const storage = new StorageService(adapter);

  const fakeData = generateFakeMeasurementData(0.5, 0.5, 1);

  const sessionData = {
    name: 'Control Room A',
    aspectRatio: '16:9',
    source: { x: 0.25, y: 0.5 },
    roomDimensions: {
      unit: 'metres',
      lengthM: 8.0,
      widthM: 4.5,
      heightM: 3.0,
      isApproximate: false,
    },
    measurements: [
      {
        id: 1,
        x: 0.5,
        y: 0.5,
        status: 'measured',
        timestamp: 1600000000000,
        pnrDb: 45.2,
        dynamicRangeDb: 48.0,
        clipped: false,
        fake: true,
        bands: fakeData.bands,
      },
      {
        id: 2,
        x: 0.75,
        y: 0.8,
        status: 'pending',
        timestamp: null,
        pnrDb: null,
        dynamicRangeDb: null,
        clipped: false,
        fake: false,
        bands: null,
      },
    ],
  };

  // 1. Save session
  const saved = await storage.save(sessionData);
  assert.ok(saved.id);
  assert.equal(saved.name, 'Control Room A');
  assert.equal(saved.aspectRatio, 16 / 9);
  assert.equal(saved.measurements.length, 2);

  // 2. Load session
  const loaded = await storage.get(saved.id);
  assert.deepEqual(loaded, saved);

  // Check pending and fake state preservation
  assert.equal(loaded.measurements[0].status, 'measured');
  assert.equal(loaded.measurements[0].fake, true);
  assert.equal(loaded.measurements[0].bands['500'].tier, 'valid');
  assert.equal(loaded.measurements[1].status, 'pending');
  assert.equal(loaded.measurements[1].fake, false);
  assert.equal(loaded.measurements[1].bands, null);

  // 3. List sessions
  const list = await storage.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, saved.id);
  assert.equal(list[0].name, 'Control Room A');
  assert.equal(list[0].pointCount, 2);
  assert.equal(list[0].hasDimensions, true);

  // 4. Rename session
  const renamed = await storage.rename(saved.id, 'Studio Main Room');
  assert.equal(renamed.name, 'Studio Main Room');
  const loadedRenamed = await storage.get(saved.id);
  assert.equal(loadedRenamed.name, 'Studio Main Room');

  // 5. Delete session
  const delRes = await storage.delete(saved.id);
  assert.equal(delRes, true);
  const afterDelete = await storage.get(saved.id);
  assert.equal(afterDelete, null);
  const listAfterDelete = await storage.list();
  assert.equal(listAfterDelete.length, 0);
});

test('Storage - Omitting roomDimensions breaks nothing and saves as null', async () => {
  const adapter = new MemoryStorageAdapter();
  const storage = new StorageService(adapter);

  const blank = storage.createBlankSession('Quick Session');
  assert.equal(blank.roomDimensions, null);
  assert.equal(blank.measurements.length, 0);

  const saved = await storage.save(blank);
  assert.equal(saved.roomDimensions, null);

  const loaded = await storage.get(saved.id);
  assert.equal(loaded.roomDimensions, null);
  assert.equal(loaded.name, 'Quick Session');
});

test('Storage - Sessions list sorts by updated descending', async () => {
  const adapter = new MemoryStorageAdapter();
  const storage = new StorageService(adapter);

  const s1 = await storage.save({ id: 's1', name: 'First', updated: 1000 });
  const s2 = await storage.save({ id: 's2', name: 'Second', updated: 2000 });
  const s3 = await storage.save({ id: 's3', name: 'Third', updated: 1500 });

  const list = await storage.list();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 's2'); // 2000
  assert.equal(list[1].id, 's3'); // 1500
  assert.equal(list[2].id, 's1'); // 1000
});
