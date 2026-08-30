// Polyfill URL.createObjectURL / revokeObjectURL for jsdom
if (typeof URL.createObjectURL === 'undefined') {
  let counter = 0
  URL.createObjectURL = (_blob: Blob) => `blob:http://localhost/${++counter}`
  URL.revokeObjectURL = (_url: string) => {}
}

// Polyfill ResizeObserver for jsdom
if (typeof ResizeObserver === 'undefined') {
  ;(globalThis as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom exposes scrollTo but implements it as a console error. The browser
// engine legitimately uses it while sizing views, so make it a harmless noop
// in the DOM test environment.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {},
  })
}
