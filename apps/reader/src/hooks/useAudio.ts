import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const pannerNodeRef = useRef<PannerNode | null>(null);
  const lfoXRef = useRef<OscillatorNode | null>(null);
  const lfoZRef = useRef<OscillatorNode | null>(null);
  const lfoGainRef = useRef<GainNode | null>(null);


  const initAudio = useCallback(async () => {
    if (audioContextRef.current) return;

    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      await context.audioWorklet.addModule('/pink-noise-processor.js');
    } catch (e) {
      console.error('Error loading audio worklet module', e);
      return;
    }
    audioContextRef.current = context;

    const noiseNode = new AudioWorkletNode(context, 'pink-noise-processor');
    const pannerNode = context.createPanner();
    const gainNode = context.createGain();

    pannerNode.panningModel = 'HRTF';
    pannerNode.distanceModel = 'inverse';
    pannerNode.setPosition(3, 0, 0);

    const lfoX = context.createOscillator();
    const lfoZ = context.createOscillator();
    const lfoGain = context.createGain();

    lfoGain.gain.value = 3;
    lfoX.type = 'sine';
    lfoZ.type = 'sine';
    lfoX.frequency.value = audio.orbitSpeed;
    lfoZ.frequency.value = audio.orbitSpeed;

    lfoX.start();
    lfoZ.start();

    noiseNode.connect(pannerNode);
    pannerNode.connect(gainNode);

    noiseNodeRef.current = noiseNode;
    pannerNodeRef.current = pannerNode;
    gainNodeRef.current = gainNode;
    lfoXRef.current = lfoX;
    lfoZRef.current = lfoZ;
    lfoGainRef.current = lfoGain;

  }, [audio.orbitSpeed]);

  useEffect(() => {
    const manageAudio = async () => {
      await initAudio();
      const context = audioContextRef.current;
      const gainNode = gainNodeRef.current;
      const pannerNode = pannerNodeRef.current;
      const lfoX = lfoXRef.current;
      const lfoZ = lfoZRef.current;
      const lfoGain = lfoGainRef.current;

      if (!context || !gainNode || !pannerNode || !lfoX || !lfoZ || !lfoGain) return;

      if (audio.isPlaying) {
        if (context.state === 'suspended') {
          await context.resume();
        }
        gainNode.connect(context.destination);

        if (audio.is8DEnabled) {
          lfoX.connect(lfoGain).connect(pannerNode.positionX);
          lfoZ.connect(lfoGain).connect(pannerNode.positionZ);
        } else {
          lfoX.disconnect();
          lfoZ.disconnect();
          pannerNode.positionX.value = 0;
          pannerNode.positionZ.value = 0;
        }

      } else {
        gainNode.disconnect();
      }
    };
    manageAudio();
  }, [audio.isPlaying, audio.is8DEnabled, initAudio]);

  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.linearRampToValueAtTime(audio.volume, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.volume]);

  useEffect(() => {
    if (lfoXRef.current && lfoZRef.current && audioContextRef.current) {
      lfoXRef.current.frequency.linearRampToValueAtTime(audio.orbitSpeed, audioContextRef.current.currentTime + 0.1);
      lfoZRef.current.frequency.linearRampToValueAtTime(audio.orbitSpeed, audioContextRef.current.currentTime + 0.1);
    }
  }, [audio.orbitSpeed]);

  const toggle = async () => {
    await initAudio();
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') {
      await context.resume();
    }
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));
  const setOrbitSpeed = (speed: number) => setAudio((prev) => ({...prev, orbitSpeed: speed}));
  const toggle8D = () => setAudio((prev) => ({...prev, is8DEnabled: !prev.is8DEnabled}));

  return { ...audio, toggle, setVolume, setOrbitSpeed, toggle8D };
};
