/* ==========================================================================
   ENIMIA Dashboard — SDF IndexedDB Cache
   Key = worldName + ":" + fileSize + ":" + lastModified
   Stores: { batchArray, centerline, meta } from sdfWorker result
   ========================================================================== */

const DB_NAME = 'enimia_sdf_cache';
const DB_VERSION = 1;
const STORE_NAME = 'worlds';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function cacheGet(cacheKey) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(cacheKey);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (e) {
    console.warn('[SdfCache] get failed:', e);
    return null;
  }
}

export async function cachePut(cacheKey, payload) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ cacheKey, ...payload, cachedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (e) {
    console.warn('[SdfCache] put failed:', e);
  }
}

export function makeCacheKey(name, size, lastModified) {
  return `${name}:${size}:${lastModified}`;
}
