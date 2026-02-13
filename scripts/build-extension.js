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

    // 2. Run the static export (SKIP_SENTRY=true and FAST_BUILD=true for speed)
    console.log('Building the reader app for static export...')

    // Default to fast build unless explicitly disabled
    const fastBuild = process.env.FAST_BUILD !== 'false'
    const skipSentry = process.env.SKIP_SENTRY !== 'false'

    execSync(
      'pnpm turbo run build:export --filter=@flow/reader --output-logs=errors-only',
      {
        stdio: 'inherit',
        cwd: rootDir,
        env: {
          ...process.env,
          SKIP_SENTRY: skipSentry ? 'true' : 'false',
          FAST_BUILD: fastBuild ? 'true' : 'false',
          NEXT_PUBLIC_IS_EXPORT: 'true',
        },
      },
    )

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

        // Update references in HTML files
        const htmlFiles = (await fs.readdir(distDir)).filter((f) =>
          f.endsWith('.html'),
        )

        // Process HTML files in parallel
        await Promise.all(
          htmlFiles.map(async (file) => {
            const filePath = path.join(distDir, file)
            let content = await fs.readFile(filePath, 'utf8')
            content = content.replace(/_next\//g, 'next_assets/')
            await fs.writeFile(filePath, content, 'utf8')
          }),
        )

        console.log('Updated references in HTML files.')
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
