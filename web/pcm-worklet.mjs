// Microphone capture: Float32 -> PCM16, batched into ~50 ms frames.
// The AudioContext is created at 24 kHz so there is no resampling here.
const FRAME = 1200 // samples @ 24 kHz = 50 ms

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(FRAME)
    this.n = 0
  }

  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === FRAME) {
        const out = this.buf.slice()
        this.port.postMessage(out.buffer, [out.buffer])
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-worklet', PCMWorklet)
