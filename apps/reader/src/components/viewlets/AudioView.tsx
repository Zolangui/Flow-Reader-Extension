import { useAudio } from '@flow/reader/hooks'

import { Button } from '../Button'
import { PaneView, PaneViewProps } from '../base'

export const AudioView: React.FC<PaneViewProps> = (props) => {
  const {
    isPlaying,
    volume,
    ambianceMix,
    flangerSpeed,
    flangerDepth,
    reverbTime,
    reverbFilter,
    toggle,
    setVolume,
    setAmbianceMix,
    setFlangerSpeed,
    setFlangerDepth,
    setReverbTime,
    setReverbFilter,
  } = useAudio()

  return (
    <PaneView {...props}>
      <div className="space-y-6 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Ambient Noise</h3>
          <Button onClick={toggle} variant={isPlaying ? 'primary' : 'secondary'}>
            {isPlaying ? 'Pause' : 'Play'}
          </Button>
        </div>

        <Slider
          label="Volume"
          id="volume"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Ambiance Mix"
          id="ambianceMix"
          min="0"
          max="1"
          step="0.01"
          value={ambianceMix}
          onChange={(e) => setAmbianceMix(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Flanger Speed"
          id="flangerSpeed"
          min="0.01"
          max="0.2"
          step="0.01"
          value={flangerSpeed}
          onChange={(e) => setFlangerSpeed(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Flanger Depth"
          id="flangerDepth"
          min="0.001"
          max="0.01"
          step="0.001"
          value={flangerDepth}
          onChange={(e) => setFlangerDepth(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Reverb Size"
          id="reverbTime"
          min="0.5"
          max="5"
          step="0.1"
          value={reverbTime}
          onChange={(e) => setReverbTime(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Reverb Tone (Dark/Bright)"
          id="reverbFilter"
          min="500"
          max="10000"
          step="100"
          value={reverbFilter}
          onChange={(e) => setReverbFilter(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
      </div>
    </PaneView>
  )
}

interface SliderProps extends React.ComponentProps<'input'> {
    label: string;
}

const Slider: React.FC<SliderProps> = ({label, id, ...props}) => (
    <div>
        <label htmlFor={id} className="mb-2 block font-semibold">
            {label}
        </label>
        <input
            id={id}
            type="range"
            className="w-full"
            {...props}
        />
    </div>
)
