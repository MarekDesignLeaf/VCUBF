'use strict';

const { Porcupine } = require('@picovoice/porcupine-node');
const { PvRecorder } = require('@picovoice/pvrecorder-node');

const keywordPath = process.argv[2] || '';
const sensitivity = Number(process.argv[3] || '0.45');
const accessKey = String(process.env.PICOVOICE_ACCESS_KEY || '').trim();

if (!accessKey || !keywordPath || !Number.isFinite(sensitivity)) {
  process.stderr.write('PICOVOICE_SIDECAR_CONFIGURATION_INVALID\n');
  process.exit(2);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true; });
}

async function main() {
  const porcupine = new Porcupine(accessKey, [keywordPath], [sensitivity]);
  const recorder = new PvRecorder(porcupine.frameLength);
  const bufferedFrames = [];
  const maxBufferedFrames = Math.ceil((porcupine.sampleRate * 2.2) / porcupine.frameLength);
  try {
    recorder.start();
    process.stdout.write(`READY ${porcupine.sampleRate} ${porcupine.frameLength}\n`);
    while (!stopping) {
      const frame = await recorder.read();
      const frameBytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      bufferedFrames.push(Buffer.from(frameBytes));
      if (bufferedFrames.length > maxBufferedFrames) bufferedFrames.shift();
      if (porcupine.process(frame) >= 0) {
        // A second local model verifies this buffer before Emma opens a
        // conversation. Porcupine alone may occasionally match ambient sound.
        process.stdout.write(`DETECTED ${Buffer.concat(bufferedFrames).toString('base64')}\n`);
        return;
      }
    }
  } finally {
    try { recorder.stop(); } catch (_) { /* already stopped */ }
    recorder.release();
    porcupine.release();
  }
}

main().catch((error) => {
  const name = error && error.name ? error.name : 'Error';
  process.stderr.write(`PICOVOICE_SIDECAR_FAILED ${name}\n`);
  process.exitCode = 1;
});
