/**
 * src/store/storage.js — Session storage layer with Adapter Pattern.
 *
 * Implements:
 *   - Adapter Pattern: MemoryStorageAdapter (for testing and fallback) & IndexedDBAdapter (for browser)
 *   - Graceful fallback: If IndexedDB is unavailable, blocked, or throws, falls back to MemoryStorageAdapter
 *   - Schema versioning: DB_NAME = 'echomap-db', DB_VERSION = 1
 *   - Session structure: { id, name, created, updated, aspectRatio, roomDimensions?, source?, measurements[] }
 *   - Full measurement schema preservation (pending/measured, fake flags, per-band metrics)
 *   - Zero dependencies, ES modules.
 */

import {
  DEFAULT_ASPECT_RATIO,
  parseAspectRatio,
  getExactAspectRatio,
} from '../ui/coordinates.js';

export const DB_NAME = 'echomap-db';
export const DB_VERSION = 1;
export const STORE_NAME = 'sessions';

/**
 * Generate a unique session ID.
 * @returns {string}
 */
export function generateSessionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `session_${ts}_${rand}`;
}

/**
 * In-memory storage adapter for testing and fallback.
 */
export class MemoryStorageAdapter {
  constructor() {
    /** @type {Map<string, object>} */
    this.store = new Map();
  }

  async saveSession(session) {
    if (!session || !session.id) {
      throw new Error('Session must have a valid id');
    }
    // Deep clone to prevent accidental outside mutations
    this.store.set(session.id, JSON.parse(JSON.stringify(session)));
    return JSON.parse(JSON.stringify(session));
  }

  async getSession(id) {
    const s = this.store.get(id);
    return s ? JSON.parse(JSON.stringify(s)) : null;
  }

  async listSessions() {
    const sessions = Array.from(this.store.values()).map((s) => {
      let exactRatio;
      const dims = s.roomDimensions;
      if (dims && Number.isFinite(dims.lengthM) && Number.isFinite(dims.widthM) && dims.lengthM > 0 && dims.widthM > 0) {
        exactRatio = dims.lengthM / dims.widthM;
      } else if (typeof s.aspectRatio === 'number') {
        exactRatio = s.aspectRatio;
      } else {
        exactRatio = parseAspectRatio(s.aspectRatio || DEFAULT_ASPECT_RATIO);
      }
      return {
        id: s.id,
        name: s.name,
        created: s.created,
        updated: s.updated,
        pointCount: Array.isArray(s.measurements) ? s.measurements.length : 0,
        aspectRatio: exactRatio,
        hasDimensions: Boolean(s.roomDimensions),
      };
    });
    // Sort by updated descending
    sessions.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return sessions;
  }

  async deleteSession(id) {
    return this.store.delete(id);
  }

  async clearAll() {
    this.store.clear();
  }
}

/**
 * Browser IndexedDB storage adapter.
 */
export class IndexedDBAdapter {
  constructor(dbName = DB_NAME, version = DB_VERSION) {
    this.dbName = dbName;
    this.version = version;
    this._db = null;
  }

  /**
   * Open IndexedDB database with schema versioning.
   * @returns {Promise<IDBDatabase>}
   */
  async _getDB() {
    if (this._db) return this._db;

    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB is not supported in this environment');
    }

    return new Promise((resolve, reject) => {
      try {
        const req = window.indexedDB.open(this.dbName, this.version);

        req.onupgradeneeded = (e) => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('updated', 'updated', { unique: false });
            store.createIndex('name', 'name', { unique: false });
          }
        };

        req.onsuccess = () => {
          this._db = req.result;
          resolve(this._db);
        };

        req.onerror = () => {
          reject(req.error || new Error('Failed to open IndexedDB'));
        };

        req.onblocked = () => {
          console.warn('[IndexedDB] Database open blocked by another tab');
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  async saveSession(session) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const serialized = JSON.parse(JSON.stringify(session));
        const req = store.put(serialized);

        req.onsuccess = () => resolve(serialized);
        req.onerror = () => reject(req.error || new Error('Failed to put session'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async getSession(id) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('Failed to get session'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async listSessions() {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();

        req.onsuccess = () => {
          const list = (req.result || []).map((s) => {
            let exactRatio;
            const dims = s.roomDimensions;
            if (dims && Number.isFinite(dims.lengthM) && Number.isFinite(dims.widthM) && dims.lengthM > 0 && dims.widthM > 0) {
              exactRatio = dims.lengthM / dims.widthM;
            } else if (typeof s.aspectRatio === 'number') {
              exactRatio = s.aspectRatio;
            } else {
              exactRatio = parseAspectRatio(s.aspectRatio || DEFAULT_ASPECT_RATIO);
            }
            return {
              id: s.id,
              name: s.name,
              created: s.created,
              updated: s.updated,
              pointCount: Array.isArray(s.measurements) ? s.measurements.length : 0,
              aspectRatio: exactRatio,
              hasDimensions: Boolean(s.roomDimensions),
            };
          });
          list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
          resolve(list);
        };

        req.onerror = () => reject(req.error || new Error('Failed to list sessions'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async deleteSession(id) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);

        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error || new Error('Failed to delete session'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async clearAll() {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error('Failed to clear sessions'));
      } catch (err) {
        reject(err);
      }
    });
  }
}

/**
 * Migrate old sessions on load.
 * Converts string / rounded aspect ratios (e.g. "1.67:1", "4:3") to exact numeric ratio R = width/height.
 * Uses dimensions when present (lengthM / widthM), otherwise stored numeric value.
 *
 * @param {object} session
 * @returns {object} migrated session
 */
export function migrateSession(session) {
  if (!session || typeof session !== 'object') return session;

  const dims = session.roomDimensions;
  if (
    dims &&
    Number.isFinite(dims.lengthM) &&
    Number.isFinite(dims.widthM) &&
    dims.lengthM > 0 &&
    dims.widthM > 0
  ) {
    session.aspectRatio = dims.lengthM / dims.widthM;
  } else if (session.aspectRatio != null) {
    session.aspectRatio = typeof session.aspectRatio === 'number' && Number.isFinite(session.aspectRatio) && session.aspectRatio > 0
      ? session.aspectRatio
      : parseAspectRatio(session.aspectRatio);
  } else {
    session.aspectRatio = DEFAULT_ASPECT_RATIO;
  }

  return session;
}

/**
 * High-level Storage Manager providing unified CRUD operations with graceful fallback.
 */
export class StorageService {
  /**
   * @param {object} [adapter]
   */
  constructor(adapter = null) {
    this._adapter = adapter;
    this._fallbackMessage = null;
    this._isInitialized = false;
  }

  async _init() {
    if (this._isInitialized) return;

    if (!this._adapter) {
      if (typeof window !== 'undefined' && 'indexedDB' in window) {
        try {
          const idbAdapter = new IndexedDBAdapter();
          await idbAdapter._getDB();
          this._adapter = idbAdapter;
        } catch (err) {
          console.warn('[StorageService] IndexedDB unavailable, falling back to memory adapter:', err);
          this._fallbackMessage = 'Storage: IndexedDB unavailable. Sessions are held in memory for this tab only.';
          this._adapter = new MemoryStorageAdapter();
        }
      } else {
        this._adapter = new MemoryStorageAdapter();
      }
    }
    this._isInitialized = true;
  }

  isPersistent() {
    return this._adapter instanceof IndexedDBAdapter;
  }

  getWarningMessage() {
    return this._fallbackMessage;
  }

  /**
   * Save session to storage. Creates new ID and timestamps if missing.
   * Stores aspectRatio as exact numeric ratio.
   *
   * @param {object} session
   * @returns {Promise<object>}
   */
  async save(session) {
    await this._init();
    if (!session || typeof session !== 'object') {
      throw new Error('Invalid session data to save');
    }

    const now = Date.now();
    const dims = session.roomDimensions;
    let exactRatio;
    if (
      dims &&
      Number.isFinite(dims.lengthM) &&
      Number.isFinite(dims.widthM) &&
      dims.lengthM > 0 &&
      dims.widthM > 0
    ) {
      exactRatio = dims.lengthM / dims.widthM;
    } else if (session.aspectRatio != null) {
      exactRatio = typeof session.aspectRatio === 'number' && Number.isFinite(session.aspectRatio) && session.aspectRatio > 0
        ? session.aspectRatio
        : parseAspectRatio(session.aspectRatio);
    } else {
      exactRatio = DEFAULT_ASPECT_RATIO;
    }

    const sessionToSave = {
      id: session.id || generateSessionId(),
      name: (session.name && session.name.trim()) || 'Untitled Session',
      created: session.created || now,
      updated: session.updated || now,
      aspectRatio: exactRatio,
      roomDimensions: dims ? { ...dims } : null,
      source: session.source ? { ...session.source } : null,
      measurements: Array.isArray(session.measurements)
        ? session.measurements.map((m) => ({
            id: m.id,
            x: m.x,
            y: m.y,
            status: m.status || 'pending',
            timestamp: m.timestamp ?? null,
            pnrDb: m.pnrDb ?? null,
            dynamicRangeDb: m.dynamicRangeDb ?? null,
            clipped: Boolean(m.clipped),
            fake: Boolean(m.fake),
            bands: m.bands ? JSON.parse(JSON.stringify(m.bands)) : null,
          }))
        : [],
    };

    return this._adapter.saveSession(sessionToSave);
  }

  /**
   * Load session by ID and migrate old schemas on load.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async get(id) {
    await this._init();
    const session = await this._adapter.getSession(id);
    if (!session) return null;
    return migrateSession(session);
  }

  /**
   * List all stored sessions.
   *
   * @returns {Promise<Array<object>>}
   */
  async list() {
    await this._init();
    const sessions = await this._adapter.listSessions();
    return sessions.map((s) => ({
      ...s,
      aspectRatio: typeof s.aspectRatio === 'number'
        ? s.aspectRatio
        : parseAspectRatio(s.aspectRatio || DEFAULT_ASPECT_RATIO),
    }));
  }

  /**
   * Delete session by ID.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    await this._init();
    return this._adapter.deleteSession(id);
  }

  /**
   * Rename session by ID.
   *
   * @param {string} id
   * @param {string} newName
   * @returns {Promise<object>}
   */
  async rename(id, newName) {
    await this._init();
    const session = await this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.name = String(newName).trim() || 'Untitled Session';
    session.updated = Date.now();
    return this._adapter.saveSession(session);
  }

  /**
   * Create a new blank session template.
   *
   * @param {string} [name='New Session']
   * @param {number|string} [aspectRatio=DEFAULT_ASPECT_RATIO]
   * @returns {object}
   */
  createBlankSession(name = 'New Session', aspectRatio = DEFAULT_ASPECT_RATIO) {
    const now = Date.now();
    return {
      id: generateSessionId(),
      name,
      created: now,
      updated: now,
      aspectRatio: typeof aspectRatio === 'number' ? aspectRatio : parseAspectRatio(aspectRatio),
      roomDimensions: null,
      source: null,
      measurements: [],
    };
  }
}

