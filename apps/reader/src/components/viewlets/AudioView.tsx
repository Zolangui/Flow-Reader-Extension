import { useAudio } from '@flow/reader/hooks'

import { Button } from '../Button'
import { PaneView, PaneViewProps } from '../base'

export const AudioView: React.FC<PaneViewProps> = (props) => {
  const {
    isPlaying,
    volume,
    toggle,
    setVolume,
    compressorThreshold,
    setCompressorThreshold,
    lowpassFreq,
    setLowpassFreq,
    midBoostFreq,
    setMidBoostFreq,
    midBoostGain,
    setMidBoostGain,
    lowShelfGain,
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

        <div className="space-y-4 rounded-md border border-gray-200 p-4 dark:border-gray-700">
            <h4 className="font-semibold">Sound Design</h4>

            <div>
              <label htmlFor="compressorThreshold" className="mb-2 block text-sm font-medium">
                Compressor Threshold
              </label>
              <input
                id="compressorThreshold"
                type="range"
                min="-100"
                max="0"
                step="1"
                value={compressorThreshold}
                onChange={(e) => setCompressorThreshold(parseFloat(e.target.value))}
                className="w-full"
                disabled={!isPlaying}
              />
            </div>

            <div>
              <label htmlFor="lowpassFreq" className="mb-2 block text-sm font-medium">
                Low-pass Cutoff
              </label>
              <input
                id="lowpassFreq"
                type="range"
                min="200"
                max="12000"
                step="100"
                value={lowpassFreq}
                onChange={(e) => setLowpassFreq(parseFloat(e.target.value))}
                className="w-full"
                disabled={!isPlaying}
              />
            </div>

            <div>
              <label htmlFor="lowShelfGain" className="mb-2 block text-sm font-medium">
                Low Shelf Gain (Bass)
              </label>
              <input
                id="lowShelfGain"
                type="range"
                min="-10"
                max="15"
                step="1"
                value={lowShelfGain}
                onChange={(e) => setLowShelfGain(parseFloat(e.target.value))}
                className="w-full"
                disabled={!isPlaying}
              />
            </div>

            <div>
              <label htmlFor="midBoostFreq" className="mb-2 block text-sm font-medium">
                Mid Boost Frequency
              </label>
              <input
                id="midBoostFreq"
                type="range"
                min="800"
                max="5000"
                step="50"
                value={midBoostFreq}
                onChange={(e) => setMidBoostFreq(parseFloat(e.target.value))}
                className="w-full"
                disabled={!isPlaying}
              />
            </div>

            <div>
              <label htmlFor="midBoostGain" className="mb-2 block text-sm font-medium">
                Mid Boost Gain
              </label>
              <input
                id="midBoostGain"
                type="range"
                min="-10"
                max="10"
                step="1"
                value={midBoostGain}
                onChange={(e) => setMidBoostGain(parseFloat(e.target.value))}
                className="w-full"
                disabled={!isPlaying}
              />
            </div>
        </div>
      </div>
    </PaneView>
  )
}
