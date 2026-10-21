// The desktop app (ADR-011) gives the game page one command: open the
// configurator (API keys, data folder). In the browser there's no such thing.

interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

const tauri = () => (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

export const desktop = {
  get present(): boolean {
    return !!tauri();
  },
  openConfigurator(): void {
    void tauri()?.core.invoke("open_configurator");
  },
};
