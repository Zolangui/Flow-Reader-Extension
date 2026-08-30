function exposeFailure(reason) {
  const detail =
    reason instanceof Error ? reason.stack || reason.message : String(reason)
  document.documentElement.dataset.fixtureStatus = 'failed'
  const status = document.getElementById('status')
  if (status) {
    status.className = 'status status-failed'
    status.textContent = 'Falhou · erro de inicialização'
  }
  const result = document.getElementById('result-json')
  if (result) result.textContent = detail
  console.error('LUMEN_PRESENTATION_FIXTURE:FAILED', reason)
}

window.addEventListener('error', (event) =>
  exposeFailure(event.error || event.message),
)
window.addEventListener('unhandledrejection', (event) =>
  exposeFailure(event.reason),
)

try {
  await import('/presentation-harness.js')
} catch (error) {
  exposeFailure(error)
}
