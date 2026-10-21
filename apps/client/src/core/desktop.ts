// The desktop app (ADR-011) gives the game page a few commands: open the
// configurator (API keys, data folder) and native sound (nativeAudio.ts).
// In the browser there's no such thing.

interface TauriGlobal {
  core: {
    invoke: (
      cmd: string,
      args?: Record<string, unknown> | Uint8Array,
      options?: { headers: Record<string, string> },
    ) => Promise<unknown>;
  };
}

const tauri = () => (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

export const desktop = {
  get present(): boolean {
    return !!tauri();
  },
  openConfigurator(): void {
    void tauri()?.core.invoke("open_configurator");
  },
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    return tauri()?.core.invoke(cmd, args) ?? Promise.resolve();
  },
  /** A command whose body is raw bytes (a sound), with its options as headers. */
  invokeBytes(cmd: string, bytes: Uint8Array, headers: Record<string, string>): Promise<unknown> {
    return tauri()?.core.invoke(cmd, bytes, { headers }) ?? Promise.resolve();
  },
};
