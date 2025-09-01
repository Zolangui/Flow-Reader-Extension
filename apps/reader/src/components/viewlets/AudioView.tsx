import { useAudio } from '@flow/reader/hooks'

import { Button } from '../Button'
import { Checkbox } from '../Form'
import { PaneView, PaneViewProps } from '../base'

export const AudioView: React.FC<PaneViewProps> = (props) => {
  const { isPlaying, volume, is8DEnabled, distance, toggle, setVolume, toggle8D, setDistance } = useAudio()

  return (
    <PaneView {...props}>
      <div className="space-y-6 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Pink Noise</h3>
          <Button onClick={toggle} variant={isPlaying ? 'primary' : 'secondary'}>
            {isPlaying ? 'Pause' : 'Play'}
          </Button>
        </div>

        <div>
          <label htmlFor="volume" className="mb-2 block font-semibold">
            Volume
          </label>
          <input
            id="volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-full"
            disabled={!isPlaying}
          />
        </div>

        <Checkbox
          name="8D Effect"
          checked={is8DEnabled}
          onChange={toggle8D}
          disabled={!isPlaying}
        />

        <div>
          <label htmlFor="distance" className="mb-2 block font-semibold">
            Distance
          </label>
          <input
            id="distance"
            type="range"
            min="500"
            max="10000"
            step="100"
            value={distance}
            onChange={(e) => setDistance(parseFloat(e.target.value))}
            className="w-full"
            disabled={!isPlaying}
          />
        </div>

      </div>
    </PaneView>
  )
}
