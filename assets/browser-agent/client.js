'use strict';
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const socket = new WebSocket(`ws://${location.host}/operator?token=${encodeURIComponent(token)}`);
let connected = false, micStream, micContext, micNode, outputContext, sdk, mediaStream;
let micEpoch = 0, mediaEpoch = 0, playbackEpoch = 0, playbackPlayed = 0, playbackEnd = 0, playbackItem = null;
const sources = new Map();
const send = (event) => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1000000) socket.send(JSON.stringify(event)); };
const log = (text) => { $('log').textContent = ($('log').textContent + text).slice(-20000); $('log').scrollTop = $('log').scrollHeight; };
function sharing() {
  send({ type: 'permissions', microphone: connected && $('microphone').checked, share: $('frames').checked, control: $('control').checked });
  const parts = [];
  if (connected && $('microphone').checked) parts.push('microphone');
  if (connected && $('frames').checked) parts.push('browser frames and page content');
  $('sharing').textContent = parts.length ? `Sending ${parts.join(' + ')} to OpenAI.${$('control').checked ? ' Browser control enabled.' : ''}` : 'Microphone and browser sharing are off.';
}
async function stopMic() {
  micEpoch++;
  if (micNode) micNode.disconnect(); micNode = null;
  if (micStream) micStream.getTracks().forEach((track) => track.stop()); micStream = null;
  const context = micContext; micContext = null;
  if (context) await context.close().catch(() => {});
}
async function startMic() {
  if (!connected || !$('microphone').checked || micStream) return;
  const epoch = ++micEpoch;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (epoch !== micEpoch || !connected || !$('microphone').checked) { stream.getTracks().forEach((track) => track.stop()); return; }
    micStream = stream;
    const context = new AudioContext({ sampleRate: 24000 });
    micContext = context;
    await context.audioWorklet.addModule('/audio-worklet.js');
    if (epoch !== micEpoch) return;
    micNode = new AudioWorkletNode(micContext, 'ninja-microphone');
    micNode.port.onmessage = (event) => {
      if (!connected || !$('microphone').checked) return;
      send({ type: 'audio', data: btoa(String.fromCharCode(...new Uint8Array(event.data))) });
    };
    const silent = micContext.createGain(); silent.gain.value = 0;
    micContext.createMediaStreamSource(micStream).connect(micNode); micNode.connect(silent); silent.connect(micContext.destination);
    await micContext.resume();
  } catch (error) { if (epoch !== micEpoch) return; $('error').textContent = `Microphone: ${error.message}`; $('microphone').checked = false; await stopMic(); sharing(); }
}
function stopPlayback(report = true) {
  playbackEpoch++;
  let played = playbackPlayed;
  if (outputContext) for (const segment of sources.values()) played += Math.max(0, Math.min(segment.duration, outputContext.currentTime - segment.start));
  if (playbackItem && report) send({ type: 'playback', item_id: playbackItem, played_ms: played * 1000 });
  for (const source of sources.keys()) { source.onended = null; try { source.stop(); } catch (_) {} }
  sources.clear(); playbackItem = null; playbackEnd = 0; playbackPlayed = 0;
}
async function audio(event) {
  if (!connected) return;
  const epoch = playbackEpoch;
  outputContext = outputContext || new AudioContext({ sampleRate: 24000 });
  await outputContext.resume();
  if (epoch !== playbackEpoch || !connected) return;
  const bytes = Uint8Array.from(atob(event.data), (value) => value.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer);
  const buffer = outputContext.createBuffer(1, samples.length, 24000);
  const data = buffer.getChannelData(0); for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768;
  if (playbackItem !== event.item_id) { stopPlayback(false); playbackItem = event.item_id; playbackEnd = outputContext.currentTime; }
  if (playbackEnd - outputContext.currentTime > 30) { send({ type: 'interrupt' }); stopPlayback(); return; }
  const source = outputContext.createBufferSource(); source.buffer = buffer; source.connect(outputContext.destination);
  const start = Math.max(outputContext.currentTime, playbackEnd); source.start(start); playbackEnd = start + buffer.duration;
  sources.set(source, { start, duration: buffer.duration }); source.onended = () => { if (sources.delete(source)) playbackPlayed += buffer.duration; };
}
async function stopWatching() {
  mediaEpoch++;
  const viewer = sdk; sdk = null;
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop()); mediaStream = null;
  $('video').srcObject = null; $('video').hidden = true; $('video').muted = true;
  $('watch').disabled = false; $('unwatch').hidden = true; $('sound').hidden = true;
  $('placeholder').hidden = !$('preview').hidden;
  if (viewer) await viewer.disconnect().catch(() => {});
}
async function watch(media) {
  if (!media.enabled) throw new Error('Live browser media is off or unavailable. Enable media on the host, or share browser frames for HTTP-compatible vision.');
  await stopWatching();
  const epoch = mediaEpoch;
  $('watch').disabled = true; $('unwatch').hidden = false; $('sound').hidden = false;
  const viewer = new VDONinjaSDK({ password: media.password, ...(media.signaling_host ? { host: media.signaling_host } : {}) });
  sdk = viewer;
  const stream = new MediaStream(); mediaStream = stream; $('video').srcObject = stream;
  viewer.addEventListener('track', (event) => { if (epoch !== mediaEpoch) { event.detail.track.stop(); return; } stream.addTrack(event.detail.track); $('video').hidden = false; $('preview').hidden = true; $('placeholder').hidden = true; });
  await viewer.connect(); if (epoch !== mediaEpoch) { await viewer.disconnect(); return; }
  await viewer.joinRoom({ room: media.room, password: media.password }); if (epoch !== mediaEpoch) { await viewer.disconnect(); return; }
  await viewer.view(media.stream_id, { audio: true, video: true });
}
socket.onmessage = async ({ data }) => {
  try {
    const event = JSON.parse(data);
    if (event.type === 'hello') { $('identity').textContent = `${event.worker} · ${event.transport} · ${event.provider} / ${event.model}`; if (!event.key_available) $('error').textContent = 'Set OPENAI_API_KEY before starting this operator server to enable the agent. Browser checks and live viewing still work.'; }
    else if (event.type === 'status') {
      connected = !!event.connected; $('status').textContent = connected ? 'Agent connected' : 'Stopped'; $('start').disabled = connected;
      if (connected) { sharing(); await startMic(); } else { await stopMic(); stopPlayback(); $('microphone').checked = false; $('frames').checked = false; $('control').checked = false; sharing(); }
      if (event.message) log(event.message + '\n');
    } else if (event.type === 'audio') await audio(event);
    else if (event.type === 'interrupt') stopPlayback();
    else if (event.type === 'text_delta') log(event.text);
    else if (event.type === 'turn_done') log('\n');
    else if (event.type === 'tool') log(`\n${event.name}: ${event.stage}${event.route ? ` (${event.route})` : ''}\n`);
    else if (event.type === 'error') { $('error').textContent = event.message; $('start').disabled = connected; }
    else if (event.type === 'worker') log(`Worker authenticated · ${event.role} · ${event.route}\n`);
    else if (event.type === 'preview') { if ($('video').hidden) { $('preview').src = `data:${event.mime};base64,${event.data}`; $('preview').hidden = false; $('placeholder').hidden = true; } $('frameTime').textContent = `Frame sent to OpenAI · ${event.captured_at}`; }
    else if (event.type === 'media') await watch(event);
  } catch (error) { $('error').textContent = error.message; }
};
socket.onclose = () => { connected = false; stopMic(); stopPlayback(false); stopWatching(); $('status').textContent = 'Disconnected'; $('error').textContent = 'The local operator disconnected. Reopen its private URL to reconnect.'; $('sharing').textContent = 'Sharing stopped.'; };
$('start').onclick = async () => { outputContext = outputContext || new AudioContext({ sampleRate: 24000 }); await outputContext.resume(); $('error').textContent = ''; $('start').disabled = true; send({ type: 'start' }); };
$('stop').onclick = () => { stopPlayback(); send({ type: 'stop' }); stopMic(); };
$('interrupt').onclick = () => { stopPlayback(); send({ type: 'interrupt' }); };
$('microphone').onchange = async () => { sharing(); if ($('microphone').checked) await startMic(); else await stopMic(); };
$('frames').onchange = () => { if (!$('frames').checked) $('control').checked = false; sharing(); if (connected && $('frames').checked) send({ type: 'frame' }); };
$('control').onchange = () => { if ($('control').checked) $('frames').checked = true; sharing(); };
$('check').onclick = () => send({ type: 'check' });
$('watch').onclick = () => send({ type: 'watch' });
$('unwatch').onclick = stopWatching;
$('sound').onclick = () => { $('video').muted = !$('video').muted; $('sound').textContent = $('video').muted ? 'Hear browser audio' : 'Mute browser audio'; };
$('message').onsubmit = (event) => { event.preventDefault(); if (!connected) { $('error').textContent = 'Start the agent before sending a message.'; return; } const text = $('text').value.trim(); if (!text) return; stopPlayback(); log(`\nYou: ${text}\n`); send({ type: 'text', text }); $('text').value = ''; };
setInterval(() => { if (connected && $('frames').checked) send({ type: 'frame' }); }, 3000);
window.addEventListener('pagehide', () => { stopMic(); if (sdk) sdk.disconnect(); socket.close(); });
