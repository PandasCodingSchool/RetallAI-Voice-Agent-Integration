/**
 * Audio transcoding helpers for the Smartflow ↔ Retell bridge.
 *
 * Smartflow → Retell  :  µ-law 8-bit 8 kHz  →  linear-16 16 kHz  (2× upsample)
 * Retell    → Smartflow:  linear-16 16 kHz   →  µ-law 8-bit 8 kHz (2× downsample)
 */

// ── µ-law decode table (ITU-T G.711) ────────────────────────────────────────
const MULAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xff;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

// ── µ-law encode table (ITU-T G.711) ────────────────────────────────────────
const MULAW_ENCODE_TABLE: Uint8Array = (() => {
  const BIAS = 0x84;
  const CLIP = 32635;
  const expLut = [0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
                  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
                  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
                  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
                  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
                  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
                  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
                  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];

  const table = new Uint8Array(65536);
  for (let pcm16 = -32768; pcm16 < 32768; pcm16++) {
    let sample = pcm16;
    let sign: number;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    } else {
      sign = 0;
    }
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    const exponent = expLut[sample >> 7];
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
    table[pcm16 & 0xffff] = ulawByte;
  }
  return table;
})();

/**
 * Convert µ-law 8-bit 8 kHz Buffer → linear-16 16 kHz Buffer (little-endian).
 * Each input sample is decoded to int16, then duplicated (nearest-neighbour 2× upsample).
 */
export function mulawToLinear16x2(mulawBuf: Buffer): Buffer {
  const numSamples = mulawBuf.length;
  const out = Buffer.allocUnsafe(numSamples * 4); // 2 bytes × 2× upsample
  let outOffset = 0;
  for (let i = 0; i < numSamples; i++) {
    const sample = MULAW_DECODE_TABLE[mulawBuf[i]];
    out.writeInt16LE(sample, outOffset);
    out.writeInt16LE(sample, outOffset + 2);
    outOffset += 4;
  }
  return out;
}

/**
 * Convert linear-16 16 kHz Buffer (little-endian) → µ-law 8-bit 8 kHz Buffer.
 * Every other sample is taken (2× downsample), then encoded to µ-law.
 */
export function linear16x2ToMulaw(pcmBuf: Buffer): Buffer {
  const numSamples = Math.floor(pcmBuf.length / 4); // take every other int16
  const out = Buffer.allocUnsafe(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const pcm16 = pcmBuf.readInt16LE(i * 4); // skip alternate sample
    out[i] = MULAW_ENCODE_TABLE[pcm16 & 0xffff];
  }
  return out;
}
