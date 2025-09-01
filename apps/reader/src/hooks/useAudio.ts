import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

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

const createProgrammaticReverb = (context: AudioContext) => {
    const input = context.createGain();
    const output = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 3500;
    const delay = context.createDelay(3.0);
    const feedback = context.createGain();
    feedback.gain.value = 0.6;

    input.connect(delay);
    delay.connect(filter);
    filter.connect(feedback);
    feedback.connect(delay);
    delay.connect(output);

    return { input, output };
};

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);

  const initAudio = useCallback(async () => {
    if (audioContextRef.current) return;

    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
        await context.audioWorklet.addModule('/pink-noise-processor.js');
    } catch(e) {
        console.error("Error loading audio worklet module", e);
        return;
    }
    audioContextRef.current = context;

    const noiseNode = new AudioWorkletNode(context, 'pink-noise-processor');
    const masterGain = context.createGain();
    const dryGain = context.createGain();
    const wetGain = context.createGain();

    const flanger = createFlanger(context);
    const reverb = createProgrammaticReverb(context);

    // Main audio chain:
    // Noise -> Dry Path -> Master Gain
    //       -> Wet Path (Flanger -> Reverb) -> Master Gain

    noiseNode.connect(dryGain);
    dryGain.connect(masterGain);

    noiseNode.connect(flanger.input);
    flanger.output.connect(reverb.input);
    reverb.output.connect(wetGain);
    wetGain.connect(masterGain);

    noiseNodeRef.current = noiseNode;
    masterGainRef.current = masterGain;
    dryGainRef.current = dryGain;
    wetGainRef.current = wetGain;
  }, []);

  useEffect(() => {
    const manageAudio = async () => {
      await initAudio();
      const context = audioContextRef.current;
      const masterGain = masterGainRef.current;

      if (!context || !masterGain) return;

      if (audio.isPlaying) {
        if (context.state === 'suspended') { await context.resume(); }
        masterGain.connect(context.destination);
      } else {
        masterGain.disconnect();
      }
    };
    manageAudio();
  }, [audio.isPlaying, initAudio]);

  useEffect(() => {
    if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.linearRampToValueAtTime(audio.volume, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.volume]);

  useEffect(() => {
    if (wetGainRef.current && audioContextRef.current) {
        // Ambiance Mix controls the volume of the "wet" signal path
        wetGainRef.current.gain.linearRampToValueAtTime(audio.ambianceMix, audioContextRef.current.currentTime + 0.1);
    }
    if (dryGainRef.current && audioContextRef.current) {
        // The dry signal is 1.0 minus the wet signal, to maintain constant overall energy
        dryGainRef.current.gain.linearRampToValueAtTime(1.0 - audio.ambianceMix, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.ambianceMix]);

  const toggle = async () => {
    await initAudio();
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') { await context.resume(); }
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));
  const setAmbianceMix = (mix: number) => setAudio((prev) => ({ ...prev, ambianceMix: mix }));

  return { ...audio, toggle, setVolume, setAmbianceMix };
};
