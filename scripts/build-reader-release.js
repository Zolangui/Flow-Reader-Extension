const { exec } = require('child_process')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const MAX_OUTPUT_BUFFER = 50 * 1024 * 1024

function ignoreBrokenPipe(stream) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error
  })
}

ignoreBrokenPipe(process.stdout)
ignoreBrokenPipe(process.stderr)

function run(name, command) {
  console.log(`Starting ${name}...`)

  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      {
        cwd: rootDir,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BUFFER,
      },
      (error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      },
    )

    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
    child.once('error', reject)
  })
}

async function main() {
  const readerFilter = '--filter=@flow/reader --output-logs=errors-only'
  const results = await Promise.allSettled([
    run('type checking', `pnpm turbo run typecheck ${readerFilter}`),
    run('linting', `pnpm turbo run lint ${readerFilter}`),
    run(
      'production bundle',
      `pnpm turbo run build:export:bundle ${readerFilter}`,
    ),
  ])

  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    failures.forEach((failure) => console.error(failure.reason))
    process.exitCode = 1
    return
  }

  console.log('Release reader build completed successfully.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
