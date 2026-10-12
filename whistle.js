// Whistle, Cactus Compute's 16.9 MB speech-to-text model, run in this page by
// its engine's WebAssembly build, Apache-2.0 (LICENSE):
//
//   needle.js, needle.wasm   huggingface.co/Cactus-Compute/needle3, wasm/, at 93e88ed
//   whistle.cact             huggingface.co/Cactus-Compute/whistle, at ca52876
//
// The engine is loaded once, on first use. Audio never leaves the page.

const here = (file) => new URL(file, import.meta.url).href;
let engine = null;

// needle.js is a classic script, not a module: it defines createNeedle.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("could not load " + src));
    document.head.append(el);
  });
}

// loadWhistle starts the engine and loads the model, once. A failed load is
// tried again on the next call.
export function loadWhistle() {
  if (!engine) {
    engine = (async () => {
      if (typeof globalThis.createNeedle !== "function") await loadScript(here("needle.js"));
      const M = await globalThis.createNeedle({ locateFile: (file) => here(file) });
      const res = await fetch(here("whistle.cact"));
      if (!res.ok) throw new Error("could not load whistle.cact (" + res.status + ")");
      const bytes = new Uint8Array(await res.arrayBuffer());
      const at = M._malloc(bytes.length);
      M.HEAPU8.set(bytes, at);
      // The size is an unsigned 64-bit integer: a BigInt on this side.
      const rc = M._needle_load(at, BigInt(bytes.length));
      M._free(at);
      if (rc < 0) throw new Error("Whistle: " + M.UTF8ToString(M._needle_last_error()));
      return M;
    })();
    engine.catch(() => { engine = null; });
  }
  return engine;
}

// transcribe turns 16 kHz mono samples in [-1, 1] into text, in English,
// leaning towards the keywords. Silence is "".
export async function transcribe(pcm, { keywords = [] } = {}) {
  const M = await loadWhistle();
  const owned = [];
  const alloc = (bytes) => {
    const at = M._malloc(bytes);
    owned.push(at);
    return at;
  };
  const cstr = (text) => {
    const bytes = new TextEncoder().encode(text + "\0");
    const at = alloc(bytes.length);
    M.HEAPU8.set(bytes, at);
    return at;
  };
  try {
    const samples = alloc(pcm.length * 4);
    // Read HEAPU8 after the allocations: a growing memory replaces it.
    new Float32Array(M.HEAPU8.buffer, samples, pcm.length).set(pcm);
    const cap = 1 << 16;
    const out = alloc(cap);
    const n = M._needle_transcribe(samples, pcm.length, cstr("en"), keywords.length ? cstr(keywords.join("\n")) : 0, 0, out, cap);
    if (n < 0) throw new Error("Whistle: " + M.UTF8ToString(M._needle_last_error()));
    return (JSON.parse(M.UTF8ToString(out)).text || "").trim();
  } finally {
    for (const at of owned) M._free(at);
  }
}
