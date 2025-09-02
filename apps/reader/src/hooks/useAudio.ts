import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);
  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const lowpassFilterRef = useRef<BiquadFilterNode | null>(null);
  const midBoostFilterRef = useRef<BiquadFilterNode | null>(null);
  const lowShelfFilterRef = useRef<BiquadFilterNode | null>(null);

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
    const compressor = context.createDynamicsCompressor();
    const lowpassFilter = context.createBiquadFilter();
    const midBoostFilter = context.createBiquadFilter();
    const lowShelfFilter = context.createBiquadFilter();
    const masterGain = context.createGain();

    // Configure Compressor
    compressor.threshold.value = audio.compressorThreshold;
    compressor.knee.value = 10;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;

    // Configure EQ Filters
    lowpassFilter.type = 'lowpass';
    lowpassFilter.frequency.value = audio.lowpassFreq;

    midBoostFilter.type = 'peaking';
    midBoostFilter.frequency.value = audio.midBoostFreq;
    midBoostFilter.gain.value = audio.midBoostGain;
    midBoostFilter.Q.value = 1.5;

    lowShelfFilter.type = 'lowshelf';
    lowShelfFilter.frequency.value = 300; // Affects frequencies below 300 Hz
    lowShelfFilter.gain.value = audio.lowShelfGain;

    // Audio Chain: Noise -> Compressor -> Low-Pass -> Mid-Boost -> Low-Shelf -> Master Gain -> Output
    noiseNode.connect(compressor);
    compressor.connect(lowpassFilter);
    lowpassFilter.connect(midBoostFilter);
    midBoostFilter.connect(lowShelfFilter);
    lowShelfFilter.connect(masterGain);

    // Store refs
    noiseNodeRef.current = noiseNode;
    compressorRef.current = compressor;
    lowpassFilterRef.current = lowpassFilter;
    midBoostFilterRef.current = midBoostFilter;
    lowShelfFilterRef.current = lowShelfFilter;
    masterGainRef.current = masterGain;

  }, [audio]); // Depend on the whole audio object for initial setup

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

  // Effects listeners for real-time control
  useEffect(() => {
    if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.linearRampToValueAtTime(audio.volume, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.volume]);

  useEffect(() => {
    if (compressorRef.current && audioContextRef.current) {
      compressorRef.current.threshold.linearRampToValueAtTime(audio.compressorThreshold, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.compressorThreshold]);

  useEffect(() => {
    if (lowpassFilterRef.current && audioContextRef.current) {
      lowpassFilterRef.current.frequency.linearRampToValueAtTime(audio.lowpassFreq, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.lowpassFreq]);

  useEffect(() => {
    if (midBoostFilterRef.current && audioContextRef.current) {
      midBoostFilterRef.current.frequency.linearRampToValueAtTime(audio.midBoostFreq, audioContextRef.current.currentTime + 0.1);
      midBoostFilterRef.current.gain.linearRampToValueAtTime(audio.midBoostGain, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.midBoostFreq, audio.midBoostGain]);

  useEffect(() => {
    if (lowShelfFilterRef.current && audioContextRef.current) {
      lowShelfFilterRef.current.gain.linearRampToValueAtTime(audio.lowShelfGain, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.lowShelfGain]);


  const toggle = async () => {
    await initAudio();
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') { await context.resume(); }
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (v: number) => setAudio((prev) => ({ ...prev, volume: v }));
  const setCompressorThreshold = (v: number) => setAudio((prev) => ({ ...prev, compressorThreshold: v }));
  const setLowpassFreq = (v: number) => setAudio((prev) => ({...prev, lowpassFreq: v}));
  const setMidBoostFreq = (v: number) => setAudio((prev) => ({...prev, midBoostFreq: v}));
  const setMidBoostGain = (v: number) => setAudio((prev) => ({...prev, midBoostGain: v}));
  const setLowShelfGain = (v: number) => setAudio((prev) => ({...prev, lowShelfGain: v}));

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
