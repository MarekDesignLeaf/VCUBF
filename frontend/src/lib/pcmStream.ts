/**
 * Raw speech samples from a stream, ready to play as they arrive.
 *
 * The backend streams OpenAI's raw 24 kHz, 16-bit little-endian samples
 * (/command/speak with `format: "pcm"`), so a reply can be heard before the
 * whole sentence has been made. This turns that byte stream into blocks of
 * float samples at the output's own rate.
 *
 * The resampling is done here and carried across blocks, so the blocks join
 * without a seam: resampled one block at a time by the browser, every join
 * could click.
 */

/** The first block is short so the voice starts at once; later ones are a little longer. */
export const FIRST_BLOCK_SECONDS = 0.2;
export const LATER_BLOCK_SECONDS = 0.25;

/**
 * Linear resampling of one continuous signal handed over in blocks. Its position
 * and the last sample of the previous block carry over, so cutting the input
 * anywhere gives exactly the output of resampling it whole.
 */
export function streamResampler(fromRate: number, toRate: number) {
  const step = fromRate / toRate;
  let produced = 0; // output samples so far; the next one sits at produced * step
  let offset = 0; // input index of the current block's first sample
  let previous = 0; // the input sample just before the current block
  return (block: Float32Array): Float32Array => {
    if (block.length === 0) return block;
    const end = offset + block.length - 1;
    const output: number[] = [];
    for (let position = produced * step; position < end; position = produced * step) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = index < offset ? previous : block[index - offset];
      const b = block[index + 1 - offset];
      output.push(a + (b - a) * fraction);
      produced += 1;
    }
    previous = block[block.length - 1];
    offset += block.length;
    return Float32Array.from(output);
  };
}

/** Blocks of float samples at `toRate`, read from a stream of 16-bit samples at `fromRate`. */
export function pcmBlocks(body: ReadableStream<Uint8Array>, fromRate: number, toRate: number) {
  const reader = body.getReader();
  const resample = streamResampler(fromRate, toRate);
  let carry: number | null = null;
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  let done = false;
  let first = true;

  const read = async (): Promise<Float32Array | null> => {
    const wanted = Math.round(fromRate * (first ? FIRST_BLOCK_SECONDS : LATER_BLOCK_SECONDS));
    while (!done && pendingLength < wanted) {
      const { value, done: ended } = await reader.read();
      if (ended) { done = true; break; }
      if (!value || value.byteLength === 0) continue;
      let bytes = value;
      // A sample can be split between two chunks of the stream.
      if (carry !== null) {
        const joined = new Uint8Array(bytes.byteLength + 1);
        joined[0] = carry;
        joined.set(bytes, 1);
        bytes = joined;
        carry = null;
      }
      const whole = bytes.byteLength - (bytes.byteLength % 2);
      if (whole < bytes.byteLength) carry = bytes[bytes.byteLength - 1];
      const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
      const samples = new Float32Array(whole / 2);
      for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
      pending.push(samples);
      pendingLength += samples.length;
    }
    if (pendingLength === 0) return null;
    const input = new Float32Array(pendingLength);
    let at = 0;
    for (const part of pending) { input.set(part, at); at += part.length; }
    pending = [];
    pendingLength = 0;
    first = false;
    const output = resample(input);
    // A block too short to give a sample (one input sample) waits for the next.
    if (output.length === 0) return done ? null : read();
    return output;
  };

  return {
    next: read,
    /** Stop reading; what has not arrived is not wanted. */
    cancel() { void reader.cancel().catch(() => undefined); },
  };
}
