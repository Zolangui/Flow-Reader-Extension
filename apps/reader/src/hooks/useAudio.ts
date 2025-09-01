import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

// Creates a "swooshing" flanger effect
const createFlanger = (context: AudioContext) => {
    const input = context.createGain();
    const output = context.createGain();
    const delay = context.createDelay(0.1);
    const feedback = context.createGain();
    feedback.gain.value = 0.5;

    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 0.05;
    lfoGain.gain.value = 0.003;

    input.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);

    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    input.connect(output);
    delay.connect(output);

    return { input, output };
};

// Creates a rich, stereo, programmatic reverb effect
const createProgrammaticReverb = (context: AudioContext) => {
    const reverbTime = 3.0;
    const input = context.createGain();
    const output = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2500;
    const delay = context.createDelay(reverbTime);
    const feedback = context.createGain();
    feedback.gain.value = 0.6;
    input.connect(delay);
    delay.connect(filter);
    filter.connect(feedback);
    feedback.connect(delay);
    delay.connect(output);
    input.connect(output);
    return { input, output };
};

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

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
    const gainNode = context.createGain();
    const lowpassFilter = context.createBiquadFilter();
    const flanger = createFlanger(context);
    const reverb = createProgrammaticReverb(context);

    lowpassFilter.type = 'lowpass';
    lowpassFilter.frequency.value = 800;
    lowpassFilter.Q.value = 1;

    // Audio Chain: Noise -> Filter -> Flanger -> Reverb -> Gain -> Output
    noiseNode.connect(lowpassFilter);
    lowpassFilter.connect(flanger.input);
    flanger.output.connect(reverb.input);
    reverb.output.connect(gainNode);

    noiseNodeRef.current = noiseNode;
    gainNodeRef.current = gainNode;

    return context;
  }, []);

  useEffect(() => {
    const manageAudio = async () => {
      await initAudio();
      const context = audioContextRef.current;
      const gainNode = gainNodeRef.current;

      if (!context || !gainNode) return;

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
