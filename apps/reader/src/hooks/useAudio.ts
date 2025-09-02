import { useEffect } from 'react';
import { useRecoilState } from 'recoil';

import { audioService } from '../audio';
import { audioState } from '../state';

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  // This effect synchronizes the Recoil state with the AudioService
  useEffect(() => {
    if (audio.isPlaying) {
      audioService.play();
    } else {
      audioService.pause();
    }
  }, [audio.isPlaying]);

  useEffect(() => {
    audioService.setVolume(audio.volume);
  }, [audio.volume]);

  useEffect(() => {
    audioService.setCompressorThreshold(audio.compressorThreshold);
  }, [audio.compressorThreshold]);

  useEffect(() => {
    audioService.setLowpassFreq(audio.lowpassFreq);
  }, [audio.lowpassFreq]);

  useEffect(() => {
    audioService.setMidBoostFreq(audio.midBoostFreq);
  }, [audio.midBoostFreq]);

  useEffect(() => {
    audioService.setMidBoostGain(audio.midBoostGain);
  }, [audio.midBoostGain]);

  useEffect(() => {
    audioService.setLowShelfGain(audio.lowShelfGain);
  }, [audio.lowShelfGain]);

  // The functions returned by the hook now only update the global state.
  const toggle = () => {
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));
  const setCompressorThreshold = (compressorThreshold: number) => setAudio((prev) => ({ ...prev, compressorThreshold }));
  const setLowpassFreq = (lowpassFreq: number) => setAudio((prev) => ({ ...prev, lowpassFreq }));
  const setMidBoostFreq = (midBoostFreq: number) => setAudio((prev) => ({ ...prev, midBoostFreq }));
  const setMidBoostGain = (midBoostGain: number) => setAudio((prev) => ({ ...prev, midBoostGain }));
  const setLowShelfGain = (lowShelfGain: number) => setAudio((prev) => ({ ...prev, lowShelfGain }));


  return {
    ...audio,
    toggle,
    setVolume,
    setCompressorThreshold,
    setLowpassFreq,
    setMidBoostFreq,
    setMidBoostGain,
    setLowShelfGain,
  };
};
