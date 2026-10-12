// voice-search: say a name, and the city goes there.
//
// "voice search" on the action ring (or v) starts listening, and it stays on
// until you have said something and stopped talking, or until nobody has said
// anything for a while. Picking it again stops it early. What was said goes
// through Whistle, a speech-to-text model that runs in this page
// (whistle.js). A name it matches for sure is selected; anything less sure is
// typed into the search box, where this plugin's matches (match.js) sit with
// the viewer's own, and you pick.

import { createMatcher, fold } from "./match.js";
import { loadWhistle, transcribe } from "./whistle.js";

export const api = 1;

const IDLE_MS = 8000; // nobody has spoken this long: stop
const END_MS = 1200; // this much quiet after speech: the request is over
const MAX_MS = 25000; // Whistle takes up to 30 s in one pass
const KEEP_MS = 300; // the quiet kept either side of the speech
const MIN_LOUD = 3; // blocks of sound (about 130 ms) before it counts as speech
const CHECK_MS = 600; // while it sounds like talking, ask Whistle this often…
const WINDOW_MS = 1500; // …whether it hears words in the last this much
const SURE = 80; // a match this good, this far ahead of the next, is selected
const MARGIN = 8;
const MAX_KEYWORDS = 60;

export default function voiceSearch(city) {
  const match = createMatcher(city.scene.packages);
  const keywords = changedNames(city.scene.packages);
  let session = null;
  let ready = false;

  // The microphone's gain control lifts the room after you stop, and that can
  // sound like talking. Whistle hears no words in noise, so a stretch it
  // finds empty is nobody talking, however loud it is.
  const nobodyTalking = async (samples, rate) => ready && !(await transcribe(linear16k(samples, rate)));

  async function toggle() {
    if (session) {
      session.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(noMicrophone);
    const current = (session = listen(nobodyTalking));
    // The model loads while you talk, so it is ready when you stop.
    loadWhistle().then(() => { ready = true; }, () => {});
    buzz(12);
    try {
      const take = await current.done;
      buzz([8, 40, 8]);
      if (take) await find(await to16k(take.samples, take.rate));
    } finally {
      if (session === current) session = null;
    }
  }

  async function find(pcm) {
    const heard = await transcribe(pcm, { keywords });
    if (!heard) return;
    const [top, next] = match(heard);
    if (top && top.score >= SURE && (!next || top.score - next.score >= MARGIN)) city.selection.select(top.node.id);
    else city.search.open(heard.replace(/[.!?,;:]+$/, ""));
  }

  city.ring.add({
    label: "voice search",
    can: () => (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? true : noMicrophone),
    run: toggle,
  });
  city.keys.add({ key: "v", does: "voice search", run: toggle });
  // What was said, typed or not, matched the way speech is.
  city.search.add({
    find: (query) => (fold(query).length < 3 ? [] : match(query).map((hit) => ({ id: hit.node.id }))),
  });

  return () => {
    if (session) session.stop();
  };
}

const noMicrophone = "the microphone needs https or localhost";

function buzz(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// changedNames are the names of what the range changed, the way they are
// said: "openBrowser" is "open Browser". Whistle leans towards them.
function changedNames(packages) {
  const spoken = (name) => name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim();
  const names = packages
    .flatMap((pkg) => pkg.entities)
    .filter((e) => e.change !== "same")
    .map((e) => spoken(e.name))
    .filter((name) => name.length > 2);
  return [...new Set(names)].slice(0, MAX_KEYWORDS);
}

// listen records from the microphone until the request is over, or until
// stop. done is { samples, rate } around the speech, or null when nobody
// spoke. While it sounds like talking, nobodyTalking(samples, rate) is asked
// about the last WINDOW_MS now and then, and a yes ends it too. The audio
// context is made here, inside the press, so the browser lets it start.
function listen(nobodyTalking) {
  const ctx = new AudioContext();
  let finish = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (finish) finish();
  };
  const done = (async () => {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (stopped) return null;
      await ctx.audioWorklet.addModule(new URL("./capture.js", import.meta.url).href);
      await ctx.resume();
      const node = new AudioWorkletNode(ctx, "voice-search-capture");
      ctx.createMediaStreamSource(stream).connect(node);
      // The node writes nothing to its output: this only keeps it running.
      node.connect(ctx.destination);
      const take = new Recording(ctx.sampleRate);
      let asking = false;
      await new Promise((resolve) => {
        finish = resolve;
        if (stopped) resolve();
        node.port.onmessage = ({ data }) => {
          if (take.add(data)) return resolve();
          if (asking || !take.dueForCheck()) return;
          asking = true;
          nobodyTalking(take.tail(WINDOW_MS), ctx.sampleRate)
            .then((quiet) => { if (quiet) resolve(); }, () => {})
            .finally(() => { asking = false; });
        };
      });
      node.port.onmessage = null;
      node.disconnect();
      return take.speech();
    } finally {
      if (stream) for (const track of stream.getTracks()) track.stop();
      ctx.close().catch(() => {});
    }
  })();
  return { stop, done };
}

// Recording keeps the microphone's blocks and says when the request is over:
// after speech and then END_MS of quiet, at MAX_MS, or after IDLE_MS with no
// speech at all. Speech is a block clearly louder than the room: the room's
// level is learnt from the quiet blocks as they come.
class Recording {
  constructor(rate) {
    this.rate = rate;
    this.blocks = [];
    this.room = null;
    this.loud = 0;
    this.first = -1;
    this.last = -1;
    this.checked = 0;
  }

  // dueForCheck is true once there has been speech for a window's worth, and
  // a check's worth of blocks since the last one.
  dueForCheck() {
    if (this.loud < MIN_LOUD) return false;
    const blockMs = (this.blocks[0].length / this.rate) * 1000;
    const now = this.blocks.length;
    if ((now - this.first) * blockMs < WINDOW_MS || (now - this.checked) * blockMs < CHECK_MS) return false;
    this.checked = now;
    return true;
  }

  // tail is the last ms of the recording.
  tail(ms) {
    const size = this.blocks[0].length;
    const count = Math.min(this.blocks.length, Math.ceil(((ms / 1000) * this.rate) / size));
    const out = new Float32Array(count * size);
    const from = this.blocks.length - count;
    for (let i = 0; i < count; i++) out.set(this.blocks[from + i], i * size);
    return out;
  }

  add(block) {
    const i = this.blocks.push(block) - 1;
    let sum = 0;
    for (const x of block) sum += x * x;
    const rms = Math.sqrt(sum / block.length);
    const room = Math.min(this.room == null ? 0.01 : this.room, 0.03);
    if (rms > Math.max(0.012, room * 3)) {
      this.loud++;
      if (this.first < 0) this.first = i;
      this.last = i;
    } else {
      this.room = this.room == null ? Math.min(rms, 0.02) : this.room * 0.9 + rms * 0.1;
    }
    const blockMs = (block.length / this.rate) * 1000;
    const elapsed = (i + 1) * blockMs;
    if (this.loud >= MIN_LOUD) return (i - this.last) * blockMs >= END_MS || elapsed >= MAX_MS;
    return elapsed >= IDLE_MS;
  }

  // speech is the recording from just before the first sound to just after
  // the last, or null when nobody spoke.
  speech() {
    if (this.loud < MIN_LOUD) return null;
    const size = this.blocks[0].length;
    const keep = Math.ceil((KEEP_MS / 1000) * this.rate / size);
    const from = Math.max(0, this.first - keep);
    const to = Math.min(this.blocks.length, this.last + 1 + keep);
    const samples = new Float32Array((to - from) * size);
    for (let i = from; i < to; i++) samples.set(this.blocks[i], (i - from) * size);
    return { samples, rate: this.rate };
  }
}

// to16k resamples to the 16 kHz Whistle hears at: through the browser's own
// resampler, or by straight lines where that is not to be had.
async function to16k(samples, rate) {
  if (rate === 16000) return samples;
  try {
    const offline = new OfflineAudioContext(1, Math.ceil((samples.length * 16000) / rate), 16000);
    const buffer = offline.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } catch {
    return linear16k(samples, rate);
  }
}

// linear16k resamples to 16 kHz by straight lines: rough, and at once.
function linear16k(samples, rate) {
  if (rate === 16000) return samples;
  const step = rate / 16000;
  const out = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const next = j + 1 < samples.length ? samples[j + 1] : samples[j];
    out[i] = samples[j] + (next - samples[j]) * (x - j);
  }
  return out;
}
