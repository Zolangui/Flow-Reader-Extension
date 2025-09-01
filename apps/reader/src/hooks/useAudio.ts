// hooks/useAudio.ts
import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);
  const audioContextRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioWorkletNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  // Função para inicializar o AudioContext e carregar o módulo do worklet
  const initAudio = useCallback(async () => {
    if (!audioContextRef.current) {
      const context = new (window.AudioContext || (window as any).webkitAudioContext)();
      // NOTE: The path must be relative to the root of the public folder
      await context.audioWorklet.addModule('/pink-noise-processor.js');
      audioContextRef.current = context;

      const noiseNode = new AudioWorkletNode(context, 'pink-noise-processor');
      const gainNode = context.createGain();

      gainNode.gain.setValueAtTime(audio.volume, context.currentTime); // Define o volume inicial
      noiseNode.connect(gainNode); // Conecta o ruído ao volume

      noiseNodeRef.current = noiseNode;
      gainNodeRef.current = gainNode;
    }
    return {
      context: audioContextRef.current,
      gainNode: gainNodeRef.current!,
    };
  }, [audio.volume]);

  useEffect(() => {
    // A função principal do efeito agora é assíncrona para lidar com a inicialização
    const manageAudio = async () => {
      // Se não for para tocar, desconecta e para.
      if (!audio.isPlaying) {
        gainNodeRef.current?.disconnect();
        return;
      }

      // Garante que o contexto de áudio seja resumido (política de autoplay)
      if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const { context, gainNode } = await initAudio();
      gainNode.connect(context.destination); // Conecta o nó de volume à saída de áudio
    };

    manageAudio();

    // Função de limpeza para quando o componente desmontar
    return () => {
      gainNodeRef.current?.disconnect();
    };
  }, [audio.isPlaying, initAudio]);

  // Efeito separado para controlar o volume em tempo real
  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.setValueAtTime(audio.volume, audioContextRef.current.currentTime);
    }
  }, [audio.volume]);

  // Funções de controle
  const play = async () => {
    // Garante que o audioContext esteja inicializado e resumido antes de tocar
    if (audioContextRef.current?.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    await initAudio(); // Garante que tudo esteja pronto
    setAudio((prev) => ({ ...prev, isPlaying: true }));
  };
  const pause = () => setAudio((prev) => ({ ...prev, isPlaying: false }));
  const toggle = () => (audio.isPlaying ? pause() : play());
  const setVolume = (volume: number) => setAudio((prev) => ({ ...prev, volume }));

  return { isPlaying: audio.isPlaying, volume: audio.volume, play, pause, toggle, setVolume };
};
