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

  // The functions returned by the hook now only update the global state.
  const toggle = () => {
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));

  return { ...audio, toggle, setVolume };
};
