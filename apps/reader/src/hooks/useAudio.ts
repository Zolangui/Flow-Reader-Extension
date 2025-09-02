import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

const createFlanger = (context: AudioContext, speed: number, depth: number) => {
    const input = context.createGain();
    const output = context.createGain();
    const delay = context.createDelay(0.1);
    const feedback = context.createGain();
    feedback.gain.value = 0.5;

    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = speed;
    lfoGain.gain.value = depth;

    input.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);

    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    input.connect(output);
    delay.connect(output);

    return { input, output, lfo, lfoGain };
};

const createProgrammaticReverb = (context: AudioContext, time: number, filterFreq: number) => {
    const input = context.createGain();
    const output = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const delay = context.createDelay(time);
    const feedback = context.createGain();
    feedback.gain.value = 0.6;

    input.connect(delay);
    delay.connect(filter);
    filter.connect(feedback);
    feedback.connect(delay);
    delay.connect(output);

    return { input, output, delay, filter, feedback };
};

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const flangerRef = useRef<any>(null);
  const reverbRef = useRef<any>(null);

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

    const flanger = createFlanger(context, audio.flangerSpeed, audio.flangerDepth);
    const reverb = createProgrammaticReverb(context, audio.reverbTime, audio.reverbFilter);

    noiseNode.connect(dryGain).connect(masterGain);
    noiseNode.connect(flanger.input);
    flanger.output.connect(reverb.input);
    reverb.output.connect(wetGain).connect(masterGain);

    noiseNodeRef.current = noiseNode;
    masterGainRef.current = masterGain;
    dryGainRef.current = dryGain;
    wetGainRef.current = wetGain;
    flangerRef.current = flanger;
    reverbRef.current = reverb;
  }, [audio.flangerSpeed, audio.flangerDepth, audio.reverbTime, audio.reverbFilter]);

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

  // Effects listeners
  useEffect(() => {
    if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.linearRampToValueAtTime(audio.volume, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.volume]);

  useEffect(() => {
    if (wetGainRef.current && audioContextRef.current) {
        wetGainRef.current.gain.linearRampToValueAtTime(audio.ambianceMix, audioContextRef.current.currentTime + 0.1);
    }
    if (dryGainRef.current && audioContextRef.current) {
        dryGainRef.current.gain.linearRampToValueAtTime(1.0 - audio.ambianceMix, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.ambianceMix]);

  useEffect(() => {
    if (flangerRef.current && audioContextRef.current) {
      flangerRef.current.lfo.frequency.linearRampToValueAtTime(audio.flangerSpeed, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.flangerSpeed]);

  useEffect(() => {
    if (flangerRef.current && audioContextRef.current) {
      flangerRef.current.lfoGain.gain.linearRampToValueAtTime(audio.flangerDepth, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.flangerDepth]);

  useEffect(() => {
    if (reverbRef.current && audioContextRef.current) {
      reverbRef.current.delay.delayTime.linearRampToValueAtTime(audio.reverbTime, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.reverbTime]);

  useEffect(() => {
    if (reverbRef.current && audioContextRef.current) {
      reverbRef.current.filter.frequency.linearRampToValueAtTime(audio.reverbFilter, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.reverbFilter]);


  const toggle = async () => {
    await initAudio();
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') { await context.resume(); }
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));
  const setAmbianceMix = (mix: number) => setAudio((prev) => ({ ...prev, ambianceMix: mix }));
  const setFlangerSpeed = (speed: number) => setAudio((prev) => ({ ...prev, flangerSpeed: speed }));
  const setFlangerDepth = (depth: number) => setAudio((prev) => ({ ...prev, flangerDepth: depth }));
  const setReverbTime = (time: number) => setAudio((prev) => ({ ...prev, reverbTime: time }));
  const setReverbFilter = (freq: number) => setAudio((prev) => ({ ...prev, reverbFilter: freq }));

  return { ...audio, toggle, setVolume, setAmbianceMix, setFlangerSpeed, setFlangerDepth, setReverbTime, setReverbFilter };
};
