;(function () {
  const background = { light: 'white', dark: '#24292e' }
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const scheme = localStorage.getItem('literal-color-scheme') || 'system'

  if (scheme === '"dark"' || (scheme === '"system"' && mediaQuery.matches)) {
    document.documentElement.classList.toggle('dark', true)
    document
      .querySelector('#theme-color')
      ?.setAttribute('content', background.dark)
  }
})()
