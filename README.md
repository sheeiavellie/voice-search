# voice-search

A [citydiff](https://github.com/naqerl/citydiff) plugin: say a name, and the city goes there.

Open the action ring and pick **voice search**, or press `v`, then say the name of a function, a type or a package. When you stop talking, the plugin finds it. If it's sure which node you meant, it selects it, the same as a click. If it isn't, it puts what you said in the search box, with its matches beside the viewer's own, and you pick one.

Speech is turned into text by [Whistle](https://cactuscompute.com/blog/whistle), Cactus Compute's 16.9 MB speech-to-text model, running in the page as WebAssembly. Audio never leaves the browser.

## Install

The plugin needs a citydiff viewer with the plugin API, version 1, proposed in [naqerl/citydiff#90](https://github.com/naqerl/citydiff/issues/90).

Clone it into citydiff's plugins directory:

```sh
git clone https://github.com/sheeiavellie/voice-search ~/.config/citydiff/plugins/voice-search
```

If you keep plugins elsewhere, clone it into the folder `CITYDIFF_PLUGINS_DIR` names. The plugins directory has to exist when citydiff starts. After that, a reload of the page picks up a new plugin.

## Use

| To | Do |
|---|---|
| Start listening | Pick **voice search** on the action ring: hold the right mouse button on the city, or hold the sheet's handle on a phone. On a keyboard, press `v`. |
| Stop early | Pick it again, or press `v` again. |

Listening stops by itself once you have said something and stopped talking, or after 8 seconds with nobody talking. On a phone, it vibrates when it starts and when it stops.

A request can be said the way you would say it to a person. Case, spaces and punctuation don't count, so "native v2 harness config" finds `NativeV2HarnessConfig` and "build candidate" finds `build_candidate`. Leading words like "go to the" are ignored, and so is a trailing kind like "function", which also favours nodes of that kind. A slightly misheard name still matches, though less strongly. Whistle is told to listen for the names the range changed, since those are the ones you are most likely to say.

### The microphone needs HTTPS

Browsers allow the microphone only on `https://` pages and on `localhost`. `http://localhost:8787` works as it is. When the viewer is opened over a plain `http://` address, from a phone say, the ring item shows as unavailable with the reason. One way to get HTTPS is to serve the viewer through `tailscale serve`.

## How it works

| File | What it does |
|---|---|
| `plugin.js` | Adds the ring item, the key and a search source, records until the request is over, and selects the match or fills the search box. |
| `match.js` | Matches what was said against the city's names. |
| `whistle.js` | Loads Whistle and turns 16 kHz audio into text. |
| `capture.js` | An audio worklet that hands the plugin the microphone's samples. |
| `needle.js`, `needle.wasm` | Cactus Compute's engine, built for WebAssembly. |
| `whistle.cact` | The Whistle model. |

**Deciding that you have finished.** A block of audio counts as speech when it is clearly louder than the room, whose level the plugin learns as it listens. Volume alone can be fooled: after you stop, the browser's gain control can lift the background noise until it sounds like talking. So while it still sounds like talking, the plugin asks Whistle every 0.6 s whether it hears any words in the last 1.5 s. Whistle hears none in noise, and an empty answer ends the request.

**Matching.** A spoken request and a name are both reduced to their letters and digits. The request is tried with and without leading filler words and a trailing kind word. The exact name scores highest. Below it, in order: a name that starts with what was said; what was said starting with the name, one word too many; a name that contains what was said; and a near miss, within about one letter in four. A node is selected only when its score is 80 or more and at least 8 ahead of the next. Anything less sure goes to the search box.

**Tuning.** The timings and thresholds are constants at the top of `plugin.js`: `END_MS` (quiet after speech that ends a request), `IDLE_MS` (how long to wait for anyone to speak), `MAX_MS`, `SURE` and `MARGIN`, and so on.

**Cost.** The engine and model are about 17.5 MB. citydiff serves a plugin's files to be revalidated, so they are downloaded once and come back as 304s after that. They load the first time you start listening, while you talk. Transcription runs on the page's main thread, and the city can stall for a moment, about 0.1 to 0.4 s, while it does.

## Licence

Apache-2.0: see [LICENSE](LICENSE). `needle.js`, `needle.wasm` and `whistle.cact` are Cactus Compute's, under the same licence: see [NOTICE](NOTICE) for where they come from.
