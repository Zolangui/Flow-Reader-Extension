const { execSync } = require('child_process')
const path = require('path')

const fs = require('fs-extra')

const browser = process.argv[2]
if (!browser || (browser !== 'chrome' && browser !== 'firefox')) {
  console.error(
    'Error: Browser name (chrome or firefox) is required as an argument.',
  )
  process.exit(1)
}

const rootDir = path.resolve(__dirname, '..')
const extensionDir = path.join(rootDir, 'apps', 'extension')
const readerDir = path.join(rootDir, 'apps', 'reader')
const distDir = path.join(extensionDir, 'dist')
const outDir = path.join(readerDir, 'out')
const manifestsDir = path.join(extensionDir, 'manifests')

async function removeWebpackFunctionFallbacks(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  let updatedFiles = 0

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      updatedFiles += await removeWebpackFunctionFallbacks(filePath)
      continue
    }
    if (!entry.isFile() || !/\.js$/i.test(entry.name)) continue

    const content = await fs.readFile(filePath, 'utf8')
    // Webpack's legacy fallback for the global object uses Function(), which
    // AMO classifies as eval even though modern extension contexts expose
    // globalThis. Replacing only this generated fallback preserves the runtime
    // behavior without enabling dynamic code execution.
    const hardened = content
      .replace(
        /return this\|\|new Function\((['"])return this\1\)\(\)/g,
        'return this||globalThis',
      )
      // Core-JS and Lodash retain this fallback for browsers without globalThis.
      // Firefox 128+ has globalThis, so it can be made CSP-safe at build time.
      .replace(/Function\((['"])return this\1\)\(\)/g, 'globalThis')
      // Browserify's setImmediate shim accepts string callbacks for legacy
      // browsers. String callbacks are incompatible with extension CSP and are
      // not used by Lumen; preserve function callbacks while safely ignoring the
      // obsolete string form.
      .replace(/new Function\(""\+([A-Za-z_$][\w$]*)\)/g, '() => {}')
      // Optional Node-only fallbacks bundled by protobuf/vm dependencies. They
      // cannot run under the extension CSP and are never needed by browser code.
      .replaceAll('eval("quire".replace(/^/,"re"))', '(() => undefined)')
      .replace(
        /eval\(this\.code\)/g,
        '(() => { throw new Error("Dynamic script execution is disabled") })()',
      )
    if (hardened !== content) {
      await fs.writeFile(filePath, hardened, 'utf8')
      updatedFiles += 1
    }
  }

  return updatedFiles
}

async function removeLegacyPolyfills(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  let removedFiles = 0

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      removedFiles += await removeLegacyPolyfills(filePath)
      continue
    }

    if (/^polyfills-[\w-]+\.js$/i.test(entry.name)) {
      await fs.remove(filePath)
      removedFiles += 1
      continue
    }

    if (!/\.html$/i.test(entry.name)) continue
    const content = await fs.readFile(filePath, 'utf8')
    const withoutPolyfills = content.replace(
      /<script\b([^>]*)><\/script>/gi,
      (tag, attributes) =>
        /\bnomodule\b/i.test(attributes) &&
        /\/polyfills-[\w-]+\.js/i.test(attributes)
          ? ''
          : tag,
    )
    if (withoutPolyfills !== content) {
      await fs.writeFile(filePath, withoutPolyfills, 'utf8')
    }
  }

  return removedFiles
}

async function verifyManifestResources(directory) {
  const manifest = await fs.readJson(path.join(directory, 'manifest.json'))
  const declared = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources.flatMap((entry) =>
        typeof entry === 'string'
          ? [entry]
          : Array.isArray(entry?.resources)
          ? entry.resources
          : [],
      )
    : []
  const missing = []
  for (const resource of declared) {
    if (resource.includes('*')) continue
    if (!(await fs.pathExists(path.join(directory, resource)))) {
      missing.push(resource)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Manifest declares missing packaged resources: ${missing.join(', ')}`,
    )
  }
}

async function build() {
  try {
    const startTime = Date.now()

    // 1. Clean the dist directory
    console.log(`Cleaning ${distDir}...`)
    await fs.remove(distDir)

    // 1.5 Generate CSP-safe wllama worker + wasm assets (for Firefox MV3).
    // These live under apps/reader/public/wasm so `next export` can include them in `out/wasm`.
    // This protects us from accidental `git clean -fd` removing untracked generated files.
    try {
      console.log('Generating wllama worker assets...')
      execSync('node scripts/generate-wllama-worker.js', {
        stdio: 'inherit',
        cwd: rootDir,
        env: { ...process.env },
      })
    } catch (e) {
      throw new Error(
        `Failed to generate required local-AI assets: ${e?.message || e}`,
      )
    }

    // 2. Build the static reader export. Release builds preserve production
    // output while lint and type checks run in parallel with the bundle.
    console.log('Building the reader app for static export...')

    const fastBuild = process.env.FAST_BUILD !== 'false'
    const skipSentry = process.env.SKIP_SENTRY !== 'false'
    const buildCommand = fastBuild
      ? 'pnpm turbo run build:export --filter=@flow/reader --output-logs=errors-only'
      : 'node scripts/build-reader-release.js'

    execSync(buildCommand, {
      stdio: 'inherit',
      cwd: rootDir,
      env: {
        ...process.env,
        SKIP_SENTRY: skipSentry ? 'true' : 'false',
        FAST_BUILD: fastBuild ? 'true' : 'false',
        NEXT_PUBLIC_IS_EXPORT: 'true',
      },
    })

    // 3. Create the dist directory
    await fs.ensureDir(distDir)

    console.log('Copying files...')

    const manifestFile =
      browser === 'chrome'
        ? 'chrome_manifest_v3.json'
        : 'firefox_manifest_v3.json'

    // 4. Copy files
    // Copy static files first (bulk copy)
    await fs.copy(outDir, distDir)

    // Overwrite specific files in parallel
    await Promise.all([
      // Copy manifest (overwrites web manifest)
      fs.copy(
        path.join(manifestsDir, manifestFile),
        path.join(distDir, 'manifest.json'),
      ),

      // Copy background script
      fs.copy(
        path.join(extensionDir, 'public', 'background.js'),
        path.join(distDir, 'background.js'),
      ),

      // Copy wllama WASM files
      fs.copy(
        path.join(
          readerDir,
          'node_modules',
          '@wllama',
          'wllama',
          'esm',
          'single-thread',
          'wllama.wasm',
        ),
        path.join(distDir, 'wasm', 'wllama-single.wasm'),
      ),
      fs.copy(
        path.join(
          readerDir,
          'node_modules',
          '@wllama',
          'wllama',
          'esm',
          'multi-thread',
          'wllama.wasm',
        ),
        path.join(distDir, 'wasm', 'wllama-multi.wasm'),
      ),
    ])

    const hardenedFiles = await removeWebpackFunctionFallbacks(distDir)
    if (hardenedFiles) {
      console.log(
        `Removed legacy Function() fallbacks from ${hardenedFiles} bundle file(s).`,
      )
    }

    const removedPolyfills = await removeLegacyPolyfills(distDir)
    if (removedPolyfills) {
      console.log(
        `Removed ${removedPolyfills} legacy nomodule polyfill file(s).`,
      )
    }

    // 5. Fix for Chrome's restrictions on filenames starting with _
    if (browser === 'chrome') {
      console.log('Applying fixes for Chrome compatibility...')

      // Rename _next to next_assets
      const oldPath = path.join(distDir, '_next')
      const newPath = path.join(distDir, 'next_assets')

      if (await fs.pathExists(oldPath)) {
        await fs.rename(oldPath, newPath)
        console.log('Renamed _next directory to next_assets.')

        // Update every generated text asset, not just HTML. The Webpack runtime
        // loads dynamic imports (such as the chatbot sidebar) from `/_next/`.
        // Rewriting only the initial HTML scripts leaves those chunks pointing to
        // a directory that no longer exists after the rename above.
        const rewriteNextAssetReferences = async (directory) => {
          const entries = await fs.readdir(directory, { withFileTypes: true })

          await Promise.all(
            entries.map(async (entry) => {
              const filePath = path.join(directory, entry.name)

              if (entry.isDirectory()) {
                await rewriteNextAssetReferences(filePath)
                return
              }

              if (!/\.(?:html|js|json|css)$/i.test(entry.name)) return

              const content = await fs.readFile(filePath, 'utf8')
              const rewritten = content.replace(/\/_next\//g, '/next_assets/')
              if (rewritten !== content) {
                await fs.writeFile(filePath, rewritten, 'utf8')
              }
            }),
          )
        }

        await rewriteNextAssetReferences(distDir)
        console.log('Updated references to renamed Next.js assets.')
      }

      // Delete problematic _.html file
      const underscoreHtml = path.join(distDir, '_.html')
      if (await fs.pathExists(underscoreHtml)) {
        await fs.remove(underscoreHtml)
        console.log('Deleted _.html file.')
      }
    }

    await verifyManifestResources(distDir)

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(
      `\n✅ Extension for ${browser} built successfully in ${duration}s!`,
    )
    console.log(`✅ Output directory: ${distDir}`)
  } catch (error) {
    console.error('\n❌ Error building the extension:', error)
    process.exit(1)
  }
}

build()
