import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';

import { audioState } from '../state';

// Creates a stereo flanger effect for a "watery" and immersive movement
const createStereoFlanger = (context: AudioContext) => {
    const input = context.createGain();
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const output = context.createGain();

    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.08; // Slow, hypnotic movement

    // Create a flanger for each channel (left and right) with slightly different parameters
    for (let i = 0; i < 2; i++) {
        const delay = context.createDelay(0.1);
        const feedback = context.createGain();
        const lfoGain = context.createGain();

        feedback.gain.value = 0.6;
        lfoGain.gain.value = i === 0 ? 0.003 : 0.0045; // Slightly different depth for stereo effect

        splitter.connect(delay, i);
        delay.connect(feedback);
        feedback.connect(delay);
        lfo.connect(lfoGain);
        lfoGain.connect(delay.delayTime);

        input.connect(delay, 0, i);
        delay.connect(merger, 0, i);
    }

    input.connect(output); // Mix in some of the original sound
    merger.connect(output);
    lfo.start();

    return { input, output };
};

// Creates a "Supermassive" reverb with multiple delay lines and diffusion
const createMassiveReverb = (context: AudioContext) => {
    const input = context.createGain();
    const output = context.createGain();
    const wetGain = context.createGain();
    wetGain.gain.value = 0.8;

    // Use 4 parallel delay lines for a dense sound
    const delayTimes = [0.41, 0.53, 0.67, 0.79]; // Prime numbers avoid resonance
    delayTimes.forEach(time => {
        const delay = context.createDelay(time * 2); // Long delay times
        const feedback = context.createGain();
        feedback.gain.value = 0.7;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2000;

        // Diffusion with Allpass Filter to smooth out echoes
        const allpass = context.createBiquadFilter();
        allpass.type = 'allpass';
        allpass.frequency.value = 1500;

        input.connect(delay);
        delay.connect(allpass);
        allpass.connect(filter);
        filter.connect(feedback);
        feedback.connect(delay);
        delay.connect(wetGain);
    });

    input.connect(output); // Dry sound
    wetGain.connect(output); // Wet sound with reverb

    return { input, output };
};


export const useAudio = () => {
  const [audio, setAudio] = useRecoilState(audioState);
  const audioContextRef = useRef<AudioContext | null>(null);
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
    const gainNode = context.createGain(); // Final Master Volume
    const lowpassFilter = context.createBiquadFilter();
    const flanger = createStereoFlanger(context);
    const reverb = createMassiveReverb(context);

    // Initial "submerged" filter settings
    lowpassFilter.type = 'lowpass';
    lowpassFilter.frequency.value = 1000;
    lowpassFilter.Q.value = 1.5;

    // The Final Effects Chain
    noiseNode.connect(lowpassFilter);
    lowpassFilter.connect(flanger.input);
    flanger.output.connect(reverb.input);
    reverb.output.connect(gainNode);

    gainNodeRef.current = gainNode;
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
