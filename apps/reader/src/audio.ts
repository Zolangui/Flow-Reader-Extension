// This service manages a single, persistent AudioContext and audio graph.
// It's created as a singleton to prevent multiple audio instances from being created
// when React components re-mount.

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

    return { input, output, lfo, lfoGain };
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

    return { input, output, delay, filter, feedback };
};


class AudioService {
    private audioContext: AudioContext | null = null;
    private noiseNode: AudioWorkletNode | null = null;
    private masterGain: GainNode | null = null;
    private dryGain: GainNode | null = null;
    private wetGain: GainNode | null = null;
    private isInitialized = false;

    private async init() {
        if (this.isInitialized) return;

        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

        try {
            await this.audioContext.audioWorklet.addModule('/pink-noise-processor.js');
        } catch(e) {
            console.error("Error loading audio worklet module", e);
            return;
        }

        const noiseNode = new AudioWorkletNode(this.audioContext, 'pink-noise-processor');
        const masterGain = this.audioContext.createGain();
        const dryGain = this.audioContext.createGain();
        const wetGain = this.audioContext.createGain();
        const flanger = createFlanger(this.audioContext);
        const reverb = createProgrammaticReverb(this.audioContext);

        noiseNode.connect(dryGain).connect(masterGain);
        noiseNode.connect(flanger.input);
        flanger.output.connect(reverb.input);
        reverb.output.connect(wetGain).connect(masterGain);

        this.noiseNode = noiseNode;
        this.masterGain = masterGain;
        this.dryGain = dryGain;
        this.wetGain = wetGain;

        this.isInitialized = true;
    }

    public async play() {
        await this.init();
        if(!this.audioContext || !this.masterGain) return;

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        this.masterGain.connect(this.audioContext.destination);
    }

    public pause() {
        if (this.masterGain) {
            this.masterGain.disconnect();
        }
    }

    public setVolume(volume: number) {
        if (this.masterGain && this.audioContext) {
            this.masterGain.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + 0.1);
        }
    }

    public setAmbianceMix(mix: number) {
        if (this.wetGain && this.dryGain && this.audioContext) {
            this.wetGain.gain.linearRampToValueAtTime(mix, this.audioContext.currentTime + 0.1);
            this.dryGain.gain.linearRampToValueAtTime(1.0 - mix, this.audioContext.currentTime + 0.1);
        }
    }
}

export const audioService = new AudioService();
