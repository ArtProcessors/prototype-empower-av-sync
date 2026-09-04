/**
 * Web storage, wrapped so a throw cannot take a session down with it.
 *
 * Private mode, a full quota and an embedded webview with storage disabled all
 * throw from `getItem`/`setItem` rather than returning nothing, and every call
 * site here treats a missing value as "no preference" anyway. Rather than
 * repeat the same try/catch at each one, they go through these.
 */

/** Which browser store a value lives in. */
export type StorageArea = 'local' | 'session'

function areaOf(area: StorageArea): Storage | null {
  try {
    return area === 'local' ? localStorage : sessionStorage
  } catch {
    return null
  }
}

/** Read a stored value, or `null` if it is absent or storage is unavailable. */
export function readStored(area: StorageArea, key: string): string | null {
  try {
    return areaOf(area)?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Store a value, silently doing nothing if storage is unavailable. */
export function writeStored(
  area: StorageArea,
  key: string,
  value: string,
): void {
  try {
    areaOf(area)?.setItem(key, value)
  } catch {
    /* private mode, or the quota is full — the value is only a convenience */
  }
}

/** Remove a stored value, silently doing nothing if storage is unavailable. */
export function removeStored(area: StorageArea, key: string): void {
  try {
    areaOf(area)?.removeItem(key)
  } catch {
    /* ignore */
  }
}
