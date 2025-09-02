import { useAudio } from '@flow/reader/hooks'

import { Button } from '../Button'
import { PaneView, PaneViewProps } from '../base'

export const AudioView: React.FC<PaneViewProps> = (props) => {
  const {
    isPlaying,
    volume,
    compressorThreshold,
    lowpassFreq,
    midBoostFreq,
    midBoostGain,
    lowShelfGain,
    toggle,
    setVolume,
    setCompressorThreshold,
    setLowpassFreq,
    setMidBoostFreq,
    setMidBoostGain,
    setLowShelfGain,
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
          label="Master Volume"
          id="volume"
          min="0" max="1" step="0.01"
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Compressor Threshold"
          id="compressorThreshold"
          min="-100" max="0" step="1"
          value={compressorThreshold}
          onChange={(e) => setCompressorThreshold(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Low-Pass Filter"
          id="lowpassFreq"
          min="200" max="10000" step="100"
          value={lowpassFreq}
          onChange={(e) => setLowpassFreq(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Mid Boost Gain"
          id="midBoostGain"
          min="0" max="12" step="0.5"
          value={midBoostGain}
          onChange={(e) => setMidBoostGain(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Mid Boost Frequency"
          id="midBoostFreq"
          min="500" max="4000" step="50"
          value={midBoostFreq}
          onChange={(e) => setMidBoostFreq(parseFloat(e.target.value))}
          disabled={!isPlaying}
        />
        <Slider
          label="Low Shelf Gain"
          id="lowShelfGain"
          min="0" max="15" step="0.5"
          value={lowShelfGain}
          onChange={(e) => setLowShelfGain(parseFloat(e.target.value))}
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
        <label htmlFor={id} className="mb-2 block text-sm font-medium text-gray-700">
            {label}
        </label>
        <input
            id={id}
            type="range"
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
            {...props}
        />
    </div>
)
