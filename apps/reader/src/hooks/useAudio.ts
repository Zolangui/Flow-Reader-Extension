import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

// Creates a more complex and convincing stereo reverb effect using multiple delays and filters.
const createProgrammaticReverb = (context: AudioContext) => {
    const input = context.createGain();
    const output = context.createGain();
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);

    input.connect(splitter);

    // Creates two delay lines (one for left, one for right) for a stereo effect
    for (let i = 0; i < 2; i++) {
        const delay = context.createDelay(i === 0 ? 2.0 : 1.49);
        const feedback = context.createGain();
        feedback.gain.value = 0.65;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 3000;

        splitter.connect(delay, i, 0);
        delay.connect(filter);
        filter.connect(feedback);
        feedback.connect(delay);

        delay.connect(merger, 0, i);
    }

    merger.connect(output);

    // Dry/Wet mix to control intensity
    const wetGain = context.createGain();
    wetGain.gain.value = 0.5; // 50% reverb
    input.connect(wetGain);
    wetGain.connect(output);

    return { input, output };
};


export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const reverbInputRef = useRef<GainNode | null>(null);

  const initAudio = useCallback(async () => {
    if (audioContextRef.current) return audioContextRef.current;

    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
        await context.audioWorklet.addModule('/pink-noise-processor.js');
    } catch(e) {
        console.error("Error loading audio worklet module", e);
        return;
    }
    audioContextRef.current = context;

    const noiseNode = new AudioWorkletNode(context, 'pink-noise-processor');
    const gainNode = context.createGain(); // Master Volume
    const reverb = createProgrammaticReverb(context);

    // Audio Chain: Noise -> Reverb -> Master Volume -> Output
    noiseNode.connect(reverb.input);
    reverb.output.connect(gainNode);

    noiseNodeRef.current = noiseNode;
    gainNodeRef.current = gainNode;
    reverbInputRef.current = reverb.input;

    return context;
  }, []);

  useEffect(() => {
    const manageAudio = async () => {
      await initAudio();
      const context = audioContextRef.current!;
      const gainNode = gainNodeRef.current!;

      if (audio.isPlaying) {
        if (context.state === 'suspended') { await context.resume(); }
        gainNode.connect(context.destination);
      } else {
        gainNode.disconnect();
      }
    };
    manageAudio();
  }, [audio.isPlaying, initAudio]);

  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
        gainNodeRef.current.gain.linearRampToValueAtTime(audio.volume, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.volume]);

  const toggle = async () => {
    await initAudio();
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') { await context.resume(); }
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));

  return { ...audio, toggle, setVolume };
};
