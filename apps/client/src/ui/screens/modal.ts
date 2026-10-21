import { h } from "./dom";

/**
 * A dialog over the current screen. Esc and the backdrop close it; focus moves
 * into it and returns when it closes. Returns close().
 */
export function openModal(
  title: string,
  body: HTMLElement,
  opts: { onClose?: () => void } = {},
): () => void {
  const back = h("div", { class: "modal-back" });
  const titleId = `m-${Math.random().toString(36).slice(2)}`;
  const box = h(
    "div",
    { class: "modal card", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h("h2", { class: "h2", id: titleId }, title),
    body,
  );
  back.append(box);
  const before = document.activeElement as HTMLElement | null;
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    before?.focus?.();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  back.addEventListener("mousedown", (e) => e.target === back && close());
  document.addEventListener("keydown", onKey, true);
  document.querySelector("#stage")!.append(back);
  box.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
  return close;
}

/** A yes/no question in the game's own style. Resolves true on confirm. */
export function confirmDialog(title: string, text: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v: boolean) => {
      answered = true;
      resolve(v);
      close();
    };
    const body = h(
      "div",
      {},
      h("p", { class: "dim" }, text),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn quiet", onclick: () => done(false) }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => done(true) }, okLabel),
      ),
    );
    const close = openModal(title, body, { onClose: () => !answered && resolve(false) });
  });
}
