// This service manages a single, persistent AudioContext and audio graph.
// It's created as a singleton to prevent multiple audio instances from being created
// when React components re-mount.

class AudioService {
    private audioContext: AudioContext | null = null;
    private isInitialized = false;

    // Audio Nodes
    private noiseNode: AudioWorkletNode | null = null;
    private masterGain: GainNode | null = null;
    private compressor: DynamicsCompressorNode | null = null;
    private lowpassFilter: BiquadFilterNode | null = null;
    private lowShelfFilter: BiquadFilterNode | null = null;
    private midPeakingFilter: BiquadFilterNode | null = null;

    private async init() {
        if (this.isInitialized) return;

        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

        try {
            // It's crucial that the path is absolute from the web root
            await this.audioContext.audioWorklet.addModule('/pink-noise-processor.js');
        } catch(e) {
            console.error("Error loading audio worklet module", e);
            return;
        }

        // Create Nodes
        this.noiseNode = new AudioWorkletNode(this.audioContext, 'pink-noise-processor');
        this.compressor = this.audioContext.createDynamicsCompressor();
        this.lowpassFilter = this.audioContext.createBiquadFilter();
        this.lowShelfFilter = this.audioContext.createBiquadFilter();
        this.midPeakingFilter = this.audioContext.createBiquadFilter();
        this.masterGain = this.audioContext.createGain();

        // Configure Nodes
        this.lowpassFilter.type = 'lowpass';
        this.lowShelfFilter.type = 'lowshelf';
        this.lowShelfFilter.frequency.value = 300; // Affects frequencies below 300 Hz
        this.midPeakingFilter.type = 'peaking';

        // Connect the graph: Noise -> Compressor -> Low-Pass -> EQ -> Master Gain
        this.noiseNode
            .connect(this.compressor)
            .connect(this.lowpassFilter)
            .connect(this.lowShelfFilter)
            .connect(this.midPeakingFilter)
            .connect(this.masterGain);

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

    // --- Setters for Audio Parameters ---

    public setVolume(volume: number) {
        if (this.masterGain && this.audioContext) {
            this.masterGain.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + 0.05);
        }
    }

    public setCompressorThreshold(value: number) {
        if (this.compressor && this.audioContext) {
            this.compressor.threshold.linearRampToValueAtTime(value, this.audioContext.currentTime + 0.05);
        }
    }

    public setLowpassFreq(value: number) {
        if (this.lowpassFilter && this.audioContext) {
            this.lowpassFilter.frequency.linearRampToValueAtTime(value, this.audioContext.currentTime + 0.05);
        }
    }

    public setLowShelfGain(value: number) {
        if (this.lowShelfFilter && this.audioContext) {
            this.lowShelfFilter.gain.linearRampToValueAtTime(value, this.audioContext.currentTime + 0.05);
        }
    }

    public setMidBoostFreq(value: number) {
        if (this.midPeakingFilter && this.audioContext) {
            this.midPeakingFilter.frequency.linearRampToValueAtTime(value, this.audioContext.currentTime + 0.05);
        }
    }

    public setMidBoostGain(value: number) {
        if (this.midPeakingFilter && this.audioContext) {
            this.midPeakingFilter.gain.linearRampToValueAtTime(value, this.audioContext.currentTime + 0.05);
        }
    }
}

export const audioService = new AudioService();
