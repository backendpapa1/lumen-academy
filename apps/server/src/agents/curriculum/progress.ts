import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { CurriculumBuild } from "@lumen/shared";

// Live progress for a curriculum build (Paul: "add a progress bar and stage
// update, so I know it's not hanging, and if there is an error truly state
// it"). The book-by-book builder reports each chapter it reads; a LangChain
// callback on every model call gives the heartbeat (calls so far, and how long
// the current one has been waiting).

export class BuildTracker extends BaseCallbackHandler {
  name = "lumen-curriculum-progress";
  private readonly inFlight = new Map<string, number>();
  private readonly chapters: Map<string, { done: number; total: number }>;
  private readonly totalChapters: number;
  readonly state: CurriculumBuild;

  constructor(
    schoolId: string,
    private readonly books: Array<{ id: string; title: string; chapters: number }>,
    private readonly emit: (s: CurriculumBuild) => void,
    extending = false,
  ) {
    super();
    const now = new Date().toISOString();
    this.chapters = new Map(books.map((b) => [b.id, { done: 0, total: Math.max(1, b.chapters) }]));
    this.totalChapters = [...this.chapters.values()].reduce((n, c) => n + c.total, 0);
    const n = books.length;
    this.state = {
      schoolId,
      status: "building",
      stage: "preparing",
      label: extending
        ? `Getting ${n === 1 ? "the new source" : `${n} new sources`} ready`
        : `Getting ${n === 1 ? "your source" : `your ${n} sources`} ready`,
      fraction: 0.02,
      sources: books.map((b) => ({ id: b.id, title: b.title, state: "waiting" })),
      calls: 0,
      startedAt: now,
      lastActivityAt: now,
      waitingSince: null,
    };
  }

  private touch(patch: Partial<CurriculumBuild> = {}) {
    Object.assign(this.state, patch, { lastActivityAt: new Date().toISOString() });
    this.state.waitingSince = this.inFlight.size
      ? new Date(Math.min(...this.inFlight.values())).toISOString()
      : null;
    this.emit(this.state);
  }

  private fraction(): number {
    const done = [...this.chapters.values()].reduce((n, c) => n + c.done, 0);
    return Math.max(this.state.fraction, 0.03 + 0.88 * (done / Math.max(1, this.totalChapters)));
  }

  private label(bookId: string): string {
    const i = this.books.findIndex((b) => b.id === bookId);
    const b = this.books[i]!;
    const c = this.chapters.get(bookId)!;
    const of = this.books.length > 1 ? ` · book ${i + 1} of ${this.books.length}` : "";
    return c.done >= c.total
      ? `Read “${b.title}”${of}`
      : `Reading “${b.title}”: chapter ${Math.min(c.total, c.done + 1)} of ${c.total}${of}`;
  }

  startBook(bookId: string) {
    const row = this.state.sources.find((s) => s.id === bookId);
    if (row) row.state = "reading";
    this.touch({ stage: "reading", label: this.label(bookId), fraction: this.fraction() });
  }

  chapterDone(bookId: string) {
    const c = this.chapters.get(bookId);
    if (c) c.done = Math.min(c.total, c.done + 1);
    this.touch({ stage: "reading", label: this.label(bookId), fraction: this.fraction() });
  }

  bookDone(bookId: string, note: string) {
    const row = this.state.sources.find((s) => s.id === bookId);
    if (row) row.state = "done";
    const c = this.chapters.get(bookId);
    if (c) c.done = c.total;
    this.touch({ stage: "saving", label: note, fraction: this.fraction() });
  }

  /** A stage the builder itself reaches (connecting books, saving). */
  stage(stage: CurriculumBuild["stage"], label: string, fraction: number) {
    this.touch({ stage, label, fraction: Math.max(this.state.fraction, fraction) });
  }

  override handleChatModelStart(_l: unknown, _m: unknown, runId: string) {
    this.inFlight.set(runId, Date.now());
    this.touch();
  }
  override handleLLMStart(_l: unknown, _p: unknown, runId: string) {
    this.inFlight.set(runId, Date.now());
    this.touch();
  }
  override handleLLMEnd(_o: unknown, runId: string) {
    this.inFlight.delete(runId);
    this.state.calls++;
    this.touch();
  }
  override handleLLMError(_e: unknown, runId: string) {
    this.inFlight.delete(runId);
    this.touch();
  }
}

/**
 * Says what went wrong in plain words, and what to do about it. The original
 * message is kept for the log.
 */
export function explainBuildError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();
  if (/budget|cap reached|over the monthly/.test(m)) {
    const spent = /\(\$([\d.]+) of \$([\d.]+)\)/.exec(raw);
    return `Stopped at your monthly budget cap${spent ? ` ($${spent[1]} of $${spent[2]})` : ""}. Raise it in Settings, then press Rebuild.`;
  }
  if (/401|403|unauthori[sz]ed|invalid api key|authentication|api key/.test(m))
    return "DeepSeek refused the API key. Check it in API keys and settings, then press Rebuild.";
  if (/is not set \(needed for/.test(m))
    return "No DeepSeek API key yet. Add it in API keys and settings, then press Rebuild.";
  if (/openai key|embeddings/.test(m))
    return "Searching your sources needs an OpenAI API key. Add it in API keys and settings, then press Rebuild.";
  if (/fetch failed|enotfound|econnrefused|econnreset|network|socket hang up|eai_again/.test(m))
    return "Couldn't reach DeepSeek: check your internet connection, then press Rebuild. What was read so far isn't saved, so it starts over.";
  if (/429|rate limit|too many requests/.test(m))
    return "DeepSeek is rate-limiting us right now. Wait a minute, then press Rebuild.";
  if (/timeout|timed out|aborted/.test(m))
    return "DeepSeek took too long to answer and the build stopped. Press Rebuild to try again.";
  if (/recursion limit|graphrecursionerror/.test(m))
    return "The Architect needed more steps than allowed for this many sources. Press Rebuild to try again, or build from a few books first and add the rest with “Add to the curriculum”.";
  if (/invalid after re-ask/.test(m)) {
    const first = raw.split(": ").slice(1).join(": ").split("; ")[0];
    return `The draft curriculum still had a problem after one fix${first ? ` (${first})` : ""}. Press Rebuild to try again.`;
  }
  if (/no indexed sources/.test(m))
    return "Add a source and wait for it to be indexed, then build.";
  return `The build stopped: ${raw}. Press Rebuild to try again.`;
}
