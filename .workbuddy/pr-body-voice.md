The voice button has been broken on the fold and nobody could say why beyond "此设备没有可用的语音识别服务". Both halves of that are now answered.

## Why it said that

The message was true. HyperOS ships exactly **one** RecognitionService - Xiaomi's - bound with a **signature-level** permission (verified: `prot=signature`), so no third-party app can bind it. The Claude app ships a second one and binds it with `BIND_RECOGNITION_SERVICE`, which is the same wall. `cmd package query-services` lists both candidates and neither is reachable. So both approaches so far - the external RecognizerIntent activity and the in-process SpeechRecognizer - had zero chance.

## The desktop had the same hole

PC voice never touched the device: it records and sends the bytes to `voice.transcribe`. But that handler only knew how to call a provider's `/audio/transcriptions`, and this machine's two providers are chat-only endpoints. `voice.precheck` returned `{ok:false, reason:"asrUnavailable"}` - **PC voice was broken too**, and the config pointed voiceModel at a chat model (`ds/deepseek-v4.1-flash`), which could never have worked.

## Two engines behind one request

New `src/server/asr.ts`:

- **local** - faster-whisper in the Python on this machine. The interpreter and the package are the entire check; no key, no network, nothing to configure. Audio goes through a temp file (what the library reads), `vad_filter` drops the silence around a press-and-hold so a short press cannot hallucinate, and an empty transcript comes back as `voice.emptyResult` so the window's existing messages apply unchanged.
- **provider** - the OpenAI-compatible call that was already there, untouched.

`voice.precheck` answers locally without a network probe; a provider engine still gets the model-list probe.

## The phone side

MediaRecorder (AAC in MP4, 16 kHz mono) -> base64 -> `voice.transcribe` -> the answer is typed into the field.

- tap mic = start, tap again = stop and transcribe
- round button becomes the stop square while recording, a spinner while transcribing
- the mic icon turns red so a live recording is never a guess
- a tap that caught nothing says 没听清，请再说一次 rather than failing

## Verified

Over the wire against a real recording: a synthesised `你好，这是一次语音识别测试` returns `precheck {ok:true}` then the transcript verbatim. Same request shape the app sends.

## Also in this pass

- Timeline rows fade and rise 8dp as they land (a streamed reply now reads as arriving, not repainting)
- A running turn keeps Claude's **working line** under the last thing said: three dots with a travelling alpha wave

On-device verification of the record -> stop -> typed-text loop is queued: the fold dropped off wireless debugging (the host still answers ping, no adb port listening), so this build is not installed yet.