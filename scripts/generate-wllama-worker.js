const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function resolveWllamaRoot() {
  // Resolve through Node so we don't depend on pnpm's internal folder layout.
  // Note: @wllama/wllama is a dependency of the reader app, so resolve from there.
  const readerDir = path.join(root, 'apps', 'reader')
  const pkgJson = require.resolve('@wllama/wllama/package.json', {
    paths: [readerDir, root],
  })
  return path.dirname(pkgJson)
}

function resolveOnnxRuntimeRoot() {
  const readerDir = path.join(root, 'apps', 'reader')
  const transformersPackage = require.resolve(
    '@xenova/transformers/package.json',
    {
      paths: [readerDir, root],
    },
  )
  const onnxPackage = require.resolve('onnxruntime-web/package.json', {
    paths: [path.dirname(transformersPackage), readerDir, root],
  })
  return path.dirname(onnxPackage)
}

const wllamaRoot = resolveWllamaRoot()
const generatedPath = path.join(
  wllamaRoot,
  'src',
  'workers-code',
  'generated.ts',
)
const outPath = path.join(root, 'apps/reader/public/wasm/wllama.worker.js')
const opfsOutPath = path.join(
  root,
  'apps/reader/public/wasm/wllama.opfs.worker.js',
)
const wasmSingleSrc = path.join(
  wllamaRoot,
  'esm',
  'single-thread',
  'wllama.wasm',
)
const wasmMultiSrc = path.join(wllamaRoot, 'esm', 'multi-thread', 'wllama.wasm')
const wasmSingleOut = path.join(
  root,
  'apps/reader/public/wasm/wllama-single.wasm',
)
const wasmMultiOut = path.join(
  root,
  'apps/reader/public/wasm/wllama-multi.wasm',
)
// Some Emscripten glue paths still default to `wllama.wasm`. Keep an alias to the single-thread build
// to avoid any fetch failures if locateFile/pathConfig are bypassed in certain environments.
const wasmSingleAliasOut = path.join(
  root,
  'apps/reader/public/wasm/wllama.wasm',
)
const onnxRuntimeRoot = resolveOnnxRuntimeRoot()
const onnxWasmNames = [
  'ort-wasm.wasm',
  'ort-wasm-threaded.wasm',
  'ort-wasm-simd.wasm',
  'ort-wasm-simd-threaded.wasm',
]

if (!fs.existsSync(generatedPath)) {
  console.error('Missing wllama generated.ts at', generatedPath)
  process.exit(1)
}

let src = fs.readFileSync(generatedPath, 'utf8')
// Convert ESM exports to a simple exports object.
src = src.replace(/export const (\w+)\s*=/g, 'exports.$1 =')

const exportsObj = {}
new Function('exports', src)(exportsObj)

const LLAMA_CPP_WORKER_CODE = exportsObj.LLAMA_CPP_WORKER_CODE
const OPFS_UTILS_WORKER_CODE = exportsObj.OPFS_UTILS_WORKER_CODE
const WLLAMA_SINGLE_THREAD_CODE = exportsObj.WLLAMA_SINGLE_THREAD_CODE

if (
  !LLAMA_CPP_WORKER_CODE ||
  !WLLAMA_SINGLE_THREAD_CODE ||
  !OPFS_UTILS_WORKER_CODE
) {
  console.error('Failed to extract worker code from generated.ts')
  process.exit(1)
}

const header = `// Auto-generated from @wllama/wllama workers-code/generated.ts
// DO NOT EDIT BY HAND. Re-run scripts/generate-wllama-worker.js
`

// Firefox MV3 (and some strict CSP environments) can be flaky with `instantiateStreaming(fetch(moz-extension://...))`,
// even when the WASM bytes are already available. Force non-streaming instantiation so we never depend on fetching the
// `.wasm` during initialization.
const disableStreaming = `if (typeof WebAssembly === 'object') {
  try { WebAssembly.instantiateStreaming = undefined; } catch {}
  try { WebAssembly.compileStreaming = undefined; } catch {}
}
`

const runOptions = `const RUN_OPTIONS = (() => {
  const base = new URL(self.location.href);
  const wasmSingle = new URL('./wllama-single.wasm', base).href;
  return {
    pathConfig: { 'wllama.wasm': wasmSingle },
    nbThread: 1,
  };
})();
`

const wasmInline = (() => {
  const bytes = fs.readFileSync(wasmSingleSrc)
  const b64 = bytes.toString('base64')
  return `const WLLAMA_WASM_BASE64 = "${b64}";
const WLLAMA_WASM_BYTES = (() => {
  const bin = atob(WLLAMA_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
})();
`
})()

// The Module config object is created in LLAMA_CPP_WORKER_CODE at runtime (module.init).
// We patch it there to include wasmBinary so Emscripten doesn't need to fetch `.wasm`.
let patchedLLamaWorkerCode = String(LLAMA_CPP_WORKER_CODE)
// Firefox MV3 disallows blob: workers (and AMO will likely reject it). The upstream code passes a blob URL
// as `mainScriptUrlOrBlob`, which makes Emscripten spawn pthread workers from blob:. Force it to a physical URL.
patchedLLamaWorkerCode = patchedLLamaWorkerCode.replace(
  'var argMainScriptBlob = _argMainScriptBlob;',
  'var argMainScriptBlob = (typeof self !== "undefined" ? self.location.href : _argMainScriptBlob);',
)
patchedLLamaWorkerCode = patchedLLamaWorkerCode.replace(
  'Module = getWModuleConfig(argMainScriptBlob);',
  'Module = getWModuleConfig(argMainScriptBlob);\n      Module.wasmBinary = WLLAMA_WASM_BYTES;',
)

// Use the upstream single-thread code, but avoid shadowing the global Module config
// (wllama creates Module at runtime, then calls wModuleInit()).
const rawModuleCode = String(WLLAMA_SINGLE_THREAD_CODE)

// CRITICAL: Rename 'var Module' to 'var ___Module' to avoid shadowing the global Module.
// This matches the upstream @wllama/wllama worker generation logic.
let mainModuleCode = rawModuleCode.replace('var Module', 'var ___Module')

// In Firefox MV3 we sometimes see `NetworkError` when the worker tries to fetch `wllama.wasm`.
// Make the Emscripten glue unconditionally fall back to our inlined bytes, avoiding any fetch.
mainModuleCode = mainModuleCode.replace(
  /var wasmBinary=Module\["wasmBinary"\];/,
  'var wasmBinary=Module["wasmBinary"]||WLLAMA_WASM_BYTES;',
)

// Belt-and-suspenders: some builds still end up calling instantiateAsync(undefined, ...)
// even though `wasmBinary` is set above. Force the argument to always be our inlined bytes.
mainModuleCode = mainModuleCode.replace(
  'var result=await instantiateAsync(wasmBinary,wasmBinaryFile,info);',
  'var result=await instantiateAsync(Module["wasmBinary"]||WLLAMA_WASM_BYTES,wasmBinaryFile,info);',
)

// Firefox MV3: `fetch(moz-extension://...)` can throw `NetworkError` inside nested workers.
// Replace Emscripten's async read path to use XHR, which works reliably for extension URLs.
mainModuleCode = mainModuleCode.replace(
  'var response=await fetch(url,{credentials:"same-origin"});if(response.ok){return response.arrayBuffer()}throw new Error(response.status+" : "+response.url)',
  'return new Promise((resolve,reject)=>{var xhr=new XMLHttpRequest;xhr.open("GET",url,true);xhr.responseType="arraybuffer";xhr.onload=()=>{if(xhr.status==200||xhr.status==0&&xhr.response){resolve(xhr.response);return}reject(new Error(xhr.status+" : "+url))};xhr.onerror=()=>reject(new Error("NetworkError"));xhr.send(null)})',
)

// Firefox MV3: even with `Module.wasmBinary` set, some upstream builds still try to fetch `binaryFile`
// because `instantiateAsync(binary, binaryFile, ...)` ignores the `binary` argument and always calls
// `instantiateArrayBuffer(binaryFile, ...)`. Patch it so we instantiate from the provided bytes when present.
const instantiateAsyncStart =
  'async function instantiateAsync(binary,binaryFile,imports){'
const instantiateAsyncEnd = 'return instantiateArrayBuffer(binaryFile,imports)}'
const startIdx = mainModuleCode.indexOf(instantiateAsyncStart)
if (startIdx !== -1) {
  const endIdx = mainModuleCode.indexOf(instantiateAsyncEnd, startIdx)
  if (endIdx !== -1) {
    const afterIdx = endIdx + instantiateAsyncEnd.length
    // Ultra-defensive: always instantiate from bytes so we never depend on fetching `.wasm` from nested workers
    // (which can throw `NetworkError` on moz-extension:// in Firefox MV3).
    const replacement = `async function instantiateAsync(binary,binaryFile,imports){binary=binary||Module[\"wasmBinary\"]||WLLAMA_WASM_BYTES;return WebAssembly.instantiate(binary,imports)}`
    mainModuleCode =
      mainModuleCode.slice(0, startIdx) +
      replacement +
      mainModuleCode.slice(afterIdx)
  } else {
    console.warn(
      'WARN: Could not locate end of instantiateAsync() in wllama single-thread code; leaving fetch path as-is',
    )
  }
} else {
  console.warn(
    'WARN: Could not locate instantiateAsync() in wllama single-thread code; leaving fetch path as-is',
  )
}

const moduleInit = `function wModuleInit() {\n${mainModuleCode}\nreturn Module;\n}\n`

const output = [
  header,
  disableStreaming,
  runOptions,
  wasmInline,
  moduleInit,
  patchedLLamaWorkerCode,
].join('\n\n')

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, output, 'utf8')

// OPFS helper worker (used by CacheManager) must also be CSP-safe in Firefox MV3.
// We ship it as a physical file so we can redirect Blob workers to it.
fs.writeFileSync(
  opfsOutPath,
  `${header}\n\n${String(OPFS_UTILS_WORKER_CODE)}`,
  'utf8',
)

if (!fs.existsSync(wasmSingleSrc) || !fs.existsSync(wasmMultiSrc)) {
  console.error(
    'Missing wllama wasm files at',
    wasmSingleSrc,
    'or',
    wasmMultiSrc,
  )
  process.exit(1)
}

fs.copyFileSync(wasmSingleSrc, wasmSingleOut)
fs.copyFileSync(wasmMultiSrc, wasmMultiOut)
fs.copyFileSync(wasmSingleSrc, wasmSingleAliasOut)

for (const name of onnxWasmNames) {
  const source = path.join(onnxRuntimeRoot, 'dist', name)
  const destination = path.join(root, 'apps/reader/public/wasm', name)
  if (!fs.existsSync(source)) {
    console.error('Missing ONNX Runtime wasm file at', source)
    process.exit(1)
  }
  fs.copyFileSync(source, destination)
  console.log('Copied', destination)
}

console.log('Generated', outPath)
console.log('Generated', opfsOutPath)
console.log('Copied', wasmSingleOut)
console.log('Copied', wasmMultiOut)
console.log('Copied', wasmSingleAliasOut)
