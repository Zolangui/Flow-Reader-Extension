// Thin re-export shim to preserve the upstream directory layout expected by:
// `fastText/helpers/modules/common.mjs` -> `import('../../core/fastText.common.js')`
//
// The actual Emscripten bundle lives at `fastText/fastText.common.js`, which we
// expose as an ESM default export for Firefox MV3.
// NOTE: Avoid `export { default } from ...` here. Firefox has been observed to
// throw "Duplicate export name 'default'" for that syntax in extension module
// graphs (likely a bundler/cache quirk). An explicit import+export is equivalent
// and more robust.
import fastTextModularized from '../fastText.common.js';
export default fastTextModularized;
