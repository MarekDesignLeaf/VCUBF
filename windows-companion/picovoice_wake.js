'use strict';

const { Porcupine } = require('@picovoice/porcupine-node');
const { PvRecorder } = require('@picovoice/pvrecorder-node');

const keywordPath = process.argv[2] || '';
const sensitivity = Number(process.argv[3] || '0.65');
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
  try {
    recorder.start();
    process.stdout.write(`READY ${porcupine.sampleRate} ${porcupine.frameLength}\n`);
    while (!stopping) {
      const frame = await recorder.read();
      if (porcupine.process(frame) >= 0) {
        process.stdout.write('DETECTED\n');
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
