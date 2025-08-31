import { useEffect } from 'react'
import { useZenMode } from '../state'

export function useZenModeHandler() {
  const [isZenMode, setZenMode] = useZenMode()

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setZenMode(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setZenMode(false)
      }
    }

    if (isZenMode) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`)
        setZenMode(false) // Revert state if request fails
      })
      document.addEventListener('keydown', handleKeyDown)
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      }
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isZenMode, setZenMode])
}
