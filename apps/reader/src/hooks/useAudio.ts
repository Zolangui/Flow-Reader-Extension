import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const pannerNodeRef = useRef<StereoPannerNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);

  const initAudio = useCallback(async () => {
    if (audioContextRef.current) return audioContextRef.current;

    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      await context.audioWorklet.addModule('/pink-noise-processor.js');
    } catch (e) {
      console.error('Error loading audio worklet module', e);
      return null;
    }
    audioContextRef.current = context;

    const noiseNode = new AudioWorkletNode(context, 'pink-noise-processor');
    const gainNode = context.createGain();
    const filterNode = context.createBiquadFilter();
    const pannerNode = context.createStereoPanner();
    const lfo = context.createOscillator();
    const lfoGain = context.createGain();

    filterNode.type = 'lowpass';
    filterNode.frequency.value = audio.distance;

    lfo.type = 'sine';
    lfo.frequency.value = 0.1;
    lfoGain.gain.value = 0.8;

    noiseNode.connect(filterNode);
    filterNode.connect(pannerNode);
    pannerNode.connect(gainNode);

    lfo.connect(lfoGain).connect(pannerNode.pan);
    lfo.start();

    noiseNodeRef.current = noiseNode;
    gainNodeRef.current = gainNode;
    filterNodeRef.current = filterNode;
    pannerNodeRef.current = pannerNode;
    lfoRef.current = lfo;

    return context;
  }, [audio.distance]);

  useEffect(() => {
    const manageAudio = async () => {
      const context = await initAudio();
      if (!context) return;

      const gainNode = gainNodeRef.current!;
      const pannerNode = pannerNodeRef.current!;

      if (audio.isPlaying) {
        if (context.state === 'suspended') {
          await context.resume();
        }
        gainNode.connect(context.destination);
        if (audio.is8DEnabled) {
          lfoRef.current?.connect(pannerNode.pan);
        } else {
          lfoRef.current?.disconnect();
          pannerNode.pan.value = 0; // Center the pan
        }
      } else {
        gainNode.disconnect();
      }
    };

    manageAudio();

    return () => {
      gainNodeRef.current?.disconnect();
    };
  }, [audio.isPlaying, audio.is8DEnabled, initAudio]);

  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
        gainNodeRef.current.gain.linearRampToValueAtTime(audio.volume, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.volume]);

  useEffect(() => {
    if (filterNodeRef.current && audioContextRef.current) {
        filterNodeRef.current.frequency.linearRampToValueAtTime(audio.distance, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.distance]);

  const toggle = async () => {
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') {
      await context.resume();
    }
    await initAudio();
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));
  const setDistance = (distance: number) => setAudio((prev) => ({...prev, distance}));
  const toggle8D = () => setAudio((prev) => ({...prev, is8DEnabled: !prev.is8DEnabled}));

  return { ...audio, toggle, setVolume, setDistance, toggle8D };
};
