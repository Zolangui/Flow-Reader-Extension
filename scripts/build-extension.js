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
      console.warn(
        'Warning: failed to generate wllama worker assets:',
        e?.message || e,
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
