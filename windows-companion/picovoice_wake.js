'use strict';

const { Porcupine } = require('@picovoice/porcupine-node');
const { PvRecorder } = require('@picovoice/pvrecorder-node');

const keywordPath = process.argv[2] || '';
const sensitivity = Number(process.argv[3] || '0.45');
const requestedDeviceName = String(process.argv[4] || '').trim().toLocaleLowerCase();
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
  const devices = PvRecorder.getAvailableDevices();
  let deviceIndex = -1;
  if (requestedDeviceName) {
    deviceIndex = devices.findIndex((name) => String(name).toLocaleLowerCase().includes(requestedDeviceName));
    if (deviceIndex < 0) {
      throw new Error(`MICROPHONE_NOT_FOUND ${requestedDeviceName}`);
    }
  }
  const recorder = new PvRecorder(porcupine.frameLength, deviceIndex);
  const bufferedFrames = [];
  const maxBufferedFrames = Math.ceil((porcupine.sampleRate * 2.2) / porcupine.frameLength);
  let levelSampleCount = 0;
  let levelSquareSum = 0;
  let levelPeak = 0;
  let lastLevelAt = Date.now();
  try {
    recorder.start();
    const selectedDevice = deviceIndex >= 0 ? devices[deviceIndex] : 'Windows default';
    process.stdout.write(`READY ${porcupine.sampleRate} ${porcupine.frameLength} ${selectedDevice}\n`);
    while (!stopping) {
      const frame = await recorder.read();
      const frameBytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      bufferedFrames.push(Buffer.from(frameBytes));
      if (bufferedFrames.length > maxBufferedFrames) bufferedFrames.shift();
      for (const sample of frame) {
        const absolute = Math.abs(sample);
        levelSquareSum += sample * sample;
        levelPeak = Math.max(levelPeak, absolute);
      }
      levelSampleCount += frame.length;
      if (Date.now() - lastLevelAt >= 1000) {
        const rms = levelSampleCount ? Math.round(Math.sqrt(levelSquareSum / levelSampleCount)) : 0;
        process.stdout.write(`AUDIO ${rms} ${levelPeak}\n`);
        levelSampleCount = 0;
        levelSquareSum = 0;
        levelPeak = 0;
        lastLevelAt = Date.now();
      }
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
  // Picovoice errors leave ``name`` as the generic "Error"; the constructor
  // carries the class that says why (for example an exhausted AccessKey
  // activation limit), and the message arrives with embedded newlines that
  // would break the single-line companion log.
  const name =
    (error && error.constructor && error.constructor.name) || (error && error.name) || 'Error';
  const message = error && error.message
    ? String(error.message).replace(/\s+/g, ' ').trim().slice(0, 300)
    : '';
  process.stderr.write(`PICOVOICE_SIDECAR_FAILED ${name} ${message}\n`);
  process.exitCode = 1;
});
