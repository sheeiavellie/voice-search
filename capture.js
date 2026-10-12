// The microphone's samples, handed to the plugin in blocks of 2048 as they
// come (about 43 ms at 48 kHz). It runs on the audio thread.
const BLOCK = 2048;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) {
      for (let i = 0; i < samples.length; i++) {
        this.block[this.filled++] = samples[i];
        if (this.filled === BLOCK) {
          this.port.postMessage(this.block);
          this.block = new Float32Array(BLOCK);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("voice-search-capture", Capture);
