import type { Speaker } from "./tts.js";
import type { Transcriber } from "./stt.js";

// The Android app (ADR-012): the phone speaks and listens itself, through
// Android's TextToSpeech and SpeechRecognizer (Kokoro's ONNX Runtime needs a
// newer CPU than many phones have, and Whisper isn't bundled). The server only
// says so ("native"), and keeps choosing each student's voice
// (/api/speech/voice), which the app maps onto the phone's voices.

const ON_DEVICE = "Speech runs on the device in the Android app.";

export class NativeSpeaker implements Speaker {
  readonly problem = null;
  status() {
    return "native" as const;
  }
  say(): Promise<never> {
    return Promise.reject(new Error(ON_DEVICE));
  }
}

export class NativeTranscriber implements Transcriber {
  readonly problem = null;
  status() {
    return "native" as const;
  }
  transcribe(): Promise<never> {
    return Promise.reject(new Error(ON_DEVICE));
  }
  close() {}
}
