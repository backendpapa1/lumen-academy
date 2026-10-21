import { desktop } from "./desktop";
import { SERVER_HTTP } from "./net";

// The Android app (ADR-012): the phone speaks and listens itself. Students and
// the narrator talk through Android's TextToSpeech and the lectern hears me
// through its SpeechRecognizer, via the app's "lumen" plugin. The plugin answers
// with `lumen-native` DOM events: each line's start and end, and the mic's level.

interface NativeEvent {
  type: "tts" | "stt";
  channel?: string;
  id?: string;
  state: string;
  level?: number;
  text?: string;
  message?: string;
}

/** How a student sounds, as the server chose it (/api/speech/voice). */
export interface VoiceChoice {
  voice: string;
  speed: number;
  register: "female" | "male";
  index: number;
  narrator: boolean;
}

type Line = { channel: string; begun: boolean; started: () => void; done: () => void };

const lines = new Map<string, Line>();
const levelListeners = new Set<(level: number) => void>();
let seq = 0;

if (typeof window !== "undefined")
  window.addEventListener("lumen-native", (e) => {
    const d = (e as CustomEvent<NativeEvent>).detail;
    if (d.type === "tts" && d.id) {
      const line = lines.get(d.id);
      if (!line) return;
      if (d.state === "start") line.started();
      else {
        lines.delete(d.id);
        line.done();
      }
    } else if (d.type === "stt" && d.state === "level")
      for (const fn of levelListeners) fn(d.level ?? 0);
  });

const choices = new Map<string, Promise<VoiceChoice | null>>();

export const android = {
  get present(): boolean {
    return (
      desktop.present && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
    );
  },

  /** A student's (or the narrator's) voice; asked once per student. */
  voiceOf(cadetId: string): Promise<VoiceChoice | null> {
    let p = choices.get(cadetId);
    if (!p) {
      p = fetch(`${SERVER_HTTP}/api/speech/voice/${encodeURIComponent(cadetId)}`)
        .then((r) => (r.ok ? (r.json() as Promise<VoiceChoice>) : null))
        .catch(() => null);
      choices.set(cadetId, p);
      void p.then((v) => v || choices.delete(cadetId));
    }
    return p;
  },

  /**
   * Queues a line on a channel ("voice" for students, "narrator"). `started`
   * fires when the phone starts saying it, `done` when it's finished, stopped or
   * failed (or if it never starts: the page must never wait on a voice).
   */
  speak(
    channel: "voice" | "narrator",
    text: string,
    voice: VoiceChoice | null,
    on: { started?: () => void; done?: () => void; volume?: number } = {},
  ): string {
    const id = `u${++seq}`;
    // A line that never starts (no engine, a dropped call) mustn't hold the page
    // up; one waiting behind a long line on its channel is fine.
    const check = () => {
      const line = lines.get(id);
      if (!line || line.begun) return;
      const busy = [...lines.values()].some((l) => l !== line && l.channel === channel && l.begun);
      if (busy) fallback = setTimeout(check, 4000);
      else {
        lines.delete(id);
        on.done?.();
      }
    };
    let fallback = setTimeout(check, 8000);
    const line: Line = {
      channel,
      begun: false,
      started: () => {
        line.begun = true;
        clearTimeout(fallback);
        on.started?.();
      },
      done: () => {
        clearTimeout(fallback);
        on.done?.();
      },
    };
    lines.set(id, line);
    void desktop
      .invoke("plugin:lumen|speak", {
        id,
        channel,
        text,
        register: voice?.register ?? "female",
        index: voice?.index ?? 0,
        rate: voice?.speed ?? 1,
        volume: on.volume ?? 1,
        queue: true,
      })
      .catch(() => {
        clearTimeout(fallback);
        lines.delete(id);
        on.done?.();
      });
    return id;
  },

  stop(channel: "voice" | "narrator"): void {
    void desktop.invoke("plugin:lumen|stop_speaking", { channel }).catch(() => undefined);
    for (const [id, line] of lines)
      if (line.channel === channel) {
        lines.delete(id);
        line.done();
      }
  },

  /** Starts listening; asks for the microphone the first time. */
  async listen(): Promise<void> {
    await desktop.invoke("plugin:lumen|listen_start", {});
  },

  /** Stops listening and gives back what was heard ("" if nothing, or cancelled). */
  async stopListening(cancel = false): Promise<string> {
    const r = (await desktop.invoke("plugin:lumen|listen_stop", { cancel })) as { text?: string };
    return r?.text ?? "";
  },

  onLevel(fn: (level: number) => void): () => void {
    levelListeners.add(fn);
    return () => levelListeners.delete(fn);
  },
};
