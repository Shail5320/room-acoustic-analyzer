import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeCSVCell,
  toJSON,
  toCSV,
  hasFakeMeasurements,
} from '../src/store/export.js';
import { generateFakeMeasurementData } from '../src/ui/session-model.js';

test('Export - escapeCSVCell properly escapes commas, quotes, and newlines', () => {
  // Plain strings remain unquoted
  assert.equal(escapeCSVCell('NormalSession'), 'NormalSession');
  assert.equal(escapeCSVCell(123), '123');
  assert.equal(escapeCSVCell(''), '');
  assert.equal(escapeCSVCell(null), '');
  assert.equal(escapeCSVCell(undefined), '');

  // Commas trigger quoting
  assert.equal(escapeCSVCell('Room A, Studio'), '"Room A, Studio"');

  // Quotes trigger doubling and wrapping
  assert.equal(escapeCSVCell('Room "Live"'), '"Room ""Live"""');

  // Newlines trigger quoting
  assert.equal(escapeCSVCell('Line1\nLine2'), '"Line1\nLine2"');

  // Tricky combined name with commas, quotes, and newlines
  const trickyName = 'Test "Master", Room #1\nTake 2';
  const escaped = escapeCSVCell(trickyName);
  assert.equal(escaped, '"Test ""Master"", Room #1\nTake 2"');
});

test('Export - toCSV emits exact column order when room dimensions are absent', () => {
  const session = {
    name: 'No Dimensions Session',
    roomDimensions: null,
    measurements: [
      {
        id: 1,
        x: 0.4,
        y: 0.6,
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

  const csv = toCSV(session);
  const lines = csv.split('\r\n');
  const header = lines[0];

  assert.equal(
    header,
    'session,point_index,status,x_rel,y_rel,band_hz,t20,t30,edt,r2,used,tier,pnr_db,dynamic_range_db,clipped,fake,timestamp'
  );

  // 1 pending point * 6 octave bands = 6 data rows
  assert.equal(lines.length, 7);

  // Verify pending row has empty measurement data cells
  const firstDataRow = lines[1];
  assert.equal(firstDataRow, 'No Dimensions Session,1,pending,0.4,0.6,125,,,,,,,,,,,');
});

test('Export - toCSV includes x_m and y_m when dimensions exist, and marks them approximate for step counts', () => {
  // Metres dimensions (exact)
  const sessionMetres = {
    name: 'Studio M',
    roomDimensions: {
      unit: 'metres',
      lengthM: 6.0,
      widthM: 4.0,
      heightM: 3.0,
      isApproximate: false,
    },
    measurements: [
      {
        id: 1,
        x: 0.5,
        y: 0.25,
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

  const csvM = toCSV(sessionMetres);
  const linesM = csvM.split('\r\n');
  assert.equal(
    linesM[0],
    'session,point_index,status,x_rel,y_rel,x_m,y_m,band_hz,t20,t30,edt,r2,used,tier,pnr_db,dynamic_range_db,clipped,fake,timestamp'
  );
  // x_m = 0.5 * 6 = 3.000, y_m = 0.25 * 4 = 1.000 (not approximate)
  assert.equal(linesM[1], 'Studio M,1,pending,0.5,0.25,3.000,1.000,125,,,,,,,,,,,');

  // Step counts dimensions (approximate)
  const sessionSteps = {
    name: 'Paced Room',
    roomDimensions: {
      unit: 'steps',
      lengthM: 7.0,
      widthM: 5.6,
      heightM: 2.8,
      isApproximate: true,
    },
    measurements: [
      {
        id: 1,
        x: 0.5,
        y: 0.5,
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

  const csvSteps = toCSV(sessionSteps);
  const linesSteps = csvSteps.split('\r\n');
  // x_m = ~3.500, y_m = ~2.800 (marked approximate with ~)
  assert.equal(linesSteps[1], 'Paced Room,1,pending,0.5,0.5,~3.500,~2.800,125,,,,,,,,,,,');
});

test('Export - toCSV populates full measured row data with fake and tier columns intact', () => {
  const fakeData = generateFakeMeasurementData(0.5, 0.5, 1);
  const session = {
    name: 'Measured "Session", 1\nTake A',
    roomDimensions: null,
    measurements: [
      {
        id: 1,
        x: 0.5,
        y: 0.5,
        status: 'measured',
        timestamp: 1700000000000,
        pnrDb: 42.5,
        dynamicRangeDb: 46.0,
        clipped: false,
        fake: true,
        bands: fakeData.bands,
      },
    ],
  };

  assert.equal(hasFakeMeasurements(session), true);

  const csv = toCSV(session);
  const lines = csv.split('\r\n');

  // Header
  assert.ok(lines[0].startsWith('session,point_index,status'));

  // First data line (band 125 Hz)
  const row125 = lines[1];
  assert.ok(row125.startsWith('"Measured ""Session"", 1\nTake A",1,measured,0.5,0.5,125,'));
  assert.ok(row125.includes(',valid,'));
  assert.ok(row125.includes(',true,1700000000000')); // fake=true, timestamp

  // Invalid band (4000 Hz) has empty values for invalid metrics but retains r2: 0.880
  const row4000 = lines[6];
  assert.ok(row4000.includes(',4000,,,,0.880,none,invalid,42.5,46.0,false,true,1700000000000'));
});

test('Export - toJSON serializes complete session state', () => {
  const session = {
    id: 's_test',
    name: 'JSON Test',
    aspectRatio: '4:3',
    roomDimensions: null,
    measurements: [],
  };

  const jsonStr = toJSON(session);
  const parsed = JSON.parse(jsonStr);
  assert.deepEqual(parsed, session);
});
