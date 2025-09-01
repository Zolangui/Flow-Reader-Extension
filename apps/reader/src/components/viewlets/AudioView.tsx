import { useAudio } from '@flow/reader/hooks'

import { Button } from '../Button'
import { PaneView, PaneViewProps } from '../base'

export const AudioView: React.FC<PaneViewProps> = (props) => {
  const { isPlaying, toggle } = useAudio()

  return (
    <PaneView {...props}>
      <div className="space-y-4 p-4">
        <div>
          <h3 className="font-semibold">Pink Noise</h3>
          <p className="text-sm text-gray-500">
            Helps to focus and block out distractions.
          </p>
        </div>
        <Button onClick={toggle} variant={isPlaying ? 'primary' : 'secondary'}>
          {isPlaying ? 'Pause' : 'Play'}
        </Button>
      </div>
    </PaneView>
  )
}
