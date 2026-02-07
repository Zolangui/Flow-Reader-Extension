// Minimal cross-browser wrapper for extension storage.
// - Firefox: `browser.storage.local.*` returns Promises.
// - Chrome: `chrome.storage.local.*` uses callbacks.
// - Fallback: `localStorage` (origin-scoped; resets when moz-extension:// UUID changes).

type StorageLike = {
  get: (keys: string | string[] | Record<string, any>) => Promise<any> | void
  set: (items: Record<string, any>) => Promise<void> | void
  remove: (keys: string | string[]) => Promise<void> | void
}

function getStorageLocal(): StorageLike | null {
  const g: any = globalThis as any
  return (g?.browser?.storage?.local as StorageLike) || (g?.chrome?.storage?.local as StorageLike) || null
}

function hasPromiseReturn(x: any): x is Promise<any> {
  return !!x && typeof x.then === 'function'
}

export async function storageGetString(key: string): Promise<string | null> {
  if (!key) return null

  const area = getStorageLocal()
  if (area) {
    try {
      const maybe = (area as any).get(key)
      const result = hasPromiseReturn(maybe)
        ? await maybe
        : await new Promise<any>((resolve) => (area as any).get(key, (v: any) => resolve(v)))
      const value = result?.[key]
      return value == null ? null : String(value)
    } catch {
      // fall through
    }
  }

  // Fallback: localStorage
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

export async function storageSetString(key: string, value: string): Promise<void> {
  if (!key) return

  const area = getStorageLocal()
  if (area) {
    try {
      const maybe = (area as any).set({ [key]: value })
      if (hasPromiseReturn(maybe)) await maybe
      else await new Promise<void>((resolve) => (area as any).set({ [key]: value }, () => resolve()))
      return
    } catch {
      // fall through
    }
  }

  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export async function storageRemove(key: string): Promise<void> {
  if (!key) return

  const area = getStorageLocal()
  if (area) {
    try {
      const maybe = (area as any).remove(key)
      if (hasPromiseReturn(maybe)) await maybe
      else await new Promise<void>((resolve) => (area as any).remove(key, () => resolve()))
      // continue to localStorage removal for parity
    } catch {
      // fall through
    }
  }

  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

