import mitt from "mitt";

// Typed event bus for one-shot events (state lives in the store).
export type BusEvents = {
  "ui:ping": void;
};

export const bus = mitt<BusEvents>();
