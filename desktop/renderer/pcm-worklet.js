class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.count = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.buffer[this.count] = channel[i];
        this.count += 1;
        if (this.count === this.buffer.length) {
          this.port.postMessage(this.buffer);
          this.buffer = new Float32Array(2048);
          this.count = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
