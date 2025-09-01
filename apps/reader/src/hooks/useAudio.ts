import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const reverbNodeRef = useRef<ConvolverNode | null>(null);
  const pannerNodeRef = useRef<PannerNode | null>(null);

  const lfoXRef = useRef<OscillatorNode | null>(null);
  const lfoZRef = useRef<OscillatorNode | null>(null);

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
    const reverbNode = context.createConvolver();
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
    lfoX.frequency.value = 0.15;
    lfoZ.frequency.value = 0.15;

    lfoX.connect(lfoGain).connect(pannerNode.positionX);
    lfoZ.connect(lfoGain).connect(pannerNode.positionZ);
    lfoX.start();
    lfoZ.start();

    try {
        const response = await fetch('/ir-hall.wav');
        const arrayBuffer = await response.arrayBuffer();
        reverbNode.buffer = await context.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.error('Error loading reverb impulse response', e);
    }

    noiseNode.connect(pannerNode);
    pannerNode.connect(reverbNode);
    reverbNode.connect(gainNode);

    noiseNodeRef.current = noiseNode;
    pannerNodeRef.current = pannerNode;
    reverbNodeRef.current = reverbNode;
    gainNodeRef.current = gainNode;
    lfoXRef.current = lfoX;
    lfoZRef.current = lfoZ;

  }, []);

  useEffect(() => {
    const manageAudio = async () => {
      await initAudio();
      const context = audioContextRef.current;
      const gainNode = gainNodeRef.current;

      if (!context || !gainNode) return;

      if (audio.isPlaying) {
        if (context.state === 'suspended') {
          await context.resume();
        }
        gainNode.connect(context.destination);
      } else {
        gainNode.disconnect();
      }
    };
    manageAudio();
  }, [audio.isPlaying, initAudio]);

  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.setValueAtTime(audio.volume, audioContextRef.current.currentTime);
    }
  }, [audio.volume]);

  const toggle = async () => {
    await initAudio();
    const context = audioContextRef.current;
    if (context && context.state === 'suspended') {
      await context.resume();
    }
    setAudio((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));

  return {
    isPlaying: audio.isPlaying,
    volume: audio.volume,
    toggle,
    setVolume
  };
};
