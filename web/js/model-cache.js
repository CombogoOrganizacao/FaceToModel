/**
 * @fileoverview FaceToModel — High Performance Binary Model Cache
 *
 * Provides persistent IndexedDB caching for 3D model buffers (.glb, .gltf, .fbx, .obj)
 * to make model switching instantaneous and eliminate redundant network downloads.
 *
 * @module model-cache
 */

// Purge legacy cache versions that may contain old Git LFS text pointers
if (typeof indexedDB !== 'undefined') {
  try {
    indexedDB.deleteDatabase('FaceToModel_Cache_v1');
    indexedDB.deleteDatabase('FaceToModel_Cache_v2');
  } catch (_) {}
}

const DB_NAME = 'FaceToModel_Cache_v4';
const STORE_NAME = 'models';
const DB_VERSION = 1;

/**
 * Checks if a buffer is a raw Git LFS text pointer rather than an actual binary asset.
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
function isLfsPointer(buffer) {
  if (!buffer || buffer.byteLength > 2048) return false;
  try {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
    return text.trimStart().startsWith('version https://');
  } catch (_) {
    return false;
  }
}

class ModelCache {
  constructor() {
    this._dbPromise = this._initDB();
  }

  async _initDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  /**
   * Retrieves a cached ArrayBuffer by key/URL.
   * @param {string} key
   * @returns {Promise<ArrayBuffer|null>}
   */
  async get(key) {
    const db = await this._dbPromise;
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const res = req.result;
          if (res && isLfsPointer(res)) {
            store.delete(key);
            resolve(null);
          } else {
            resolve(res || null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  /**
   * Deletes a cached model entry.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    const db = await this._dbPromise;
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  /**
   * Stores an ArrayBuffer in IndexedDB by key/URL.
   * @param {string} key
   * @param {ArrayBuffer} buffer
   * @returns {Promise<void>}
   */
  async set(key, buffer) {
    const db = await this._dbPromise;
    if (!db || !buffer || isLfsPointer(buffer)) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(buffer, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  /**
   * Fetch a model with progress tracking and automatic IndexedDB caching.
   * @param {string} url
   * @param {function({ loaded: number, total: number, percent: number }): void} [onProgress]
   * @returns {Promise<ArrayBuffer>}
   */
  async fetchWithCache(url, onProgress = null) {
    // 1. Try to read from IndexedDB
    const cached = await this.get(url);
    if (cached) {
      if (onProgress) onProgress({ loaded: cached.byteLength, total: cached.byteLength, percent: 100 });
      return cached;
    }

    // 2. Stream download over network with real-time progress
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';

      xhr.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress({ loaded: event.loaded, total: event.total, percent });
        } else if (onProgress) {
          onProgress({ loaded: event.loaded, total: 0, percent: -1 });
        }
      };

      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const buffer = xhr.response;
          if (buffer) {
            if (isLfsPointer(buffer)) {
              console.error(`[ModelCache] Received Git LFS text pointer for: ${url}`);
              reject(new Error(`O servidor retornou um ponteiro de texto Git LFS. Atualize a página com cache limpo.`));
              return;
            }
            // Save to local cache in background
            this.set(url, buffer).catch(() => {});
            if (onProgress) onProgress({ loaded: buffer.byteLength, total: buffer.byteLength, percent: 100 });
            resolve(buffer);
          } else {
            reject(new Error(`Buffer de modelo vazio para: ${url}`));
          }
        } else {
          reject(new Error(`Falha no download HTTP (${xhr.status}) para: ${url}`));
        }
      };

      xhr.onerror = () => reject(new Error(`Erro de rede ao baixar: ${url}`));
      xhr.send();
    });
  }
}

export const modelCache = new ModelCache();
