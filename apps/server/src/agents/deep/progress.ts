import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { CurriculumBuild } from "@lumen/shared";

// Live progress for the Curriculum Architect (Paul: "add a progress bar and
// stage update, so I know it's not hanging, and if there is an error truly
// state it"). A LangChain callback sees every model call and tool call, the
// subagents' too (deepagents passes the config down), and turns them into a
// stage, a fraction and a heartbeat:
//
//   reading each source (the source-analyst writes /work/candidates/<id>.json)
//   → ordering (the curriculum-editor) → checking (/out/curriculum.json)
//   → fixing (one re-ask, if the check failed) → saving.

const SHARE = { reading: 0.78, ordering: 0.12, checking: 0.05 } as const;

export class BuildTracker extends BaseCallbackHandler {
  name = "lumen-curriculum-progress";
  private readonly done = new Set<string>();
  private readonly started = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  readonly state: CurriculumBuild;

  constructor(
    schoolId: string,
    private readonly sources: Array<{ id: string; title: string }>,
    private readonly emit: (s: CurriculumBuild) => void,
    extending = false,
  ) {
    super();
    const now = new Date().toISOString();
    this.state = {
      schoolId,
      status: "building",
      stage: "preparing",
      label: extending
        ? `Getting ${sources.length === 1 ? "the new source" : `${sources.length} new sources`} ready`
        : `Getting ${sources.length === 1 ? "your source" : `your ${sources.length} sources`} ready`,
      fraction: 0.02,
      sources: sources.map((s) => ({ id: s.id, title: s.title, state: "waiting" })),
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

  private readingFraction(): number {
    const n = Math.max(1, this.sources.length);
    const partial = [...this.started].filter((id) => !this.done.has(id)).length * 0.4;
    return 0.03 + SHARE.reading * Math.min(1, (this.done.size + partial) / n);
  }

  private sourceIn(text: string): { id: string; title: string } | undefined {
    return (
      this.sources.find((s) => text.includes(s.id)) ??
      this.sources.find((s) => text.toLowerCase().includes(s.title.toLowerCase()))
    );
  }

  private mark(id: string, state: "reading" | "done") {
    const row = this.state.sources.find((s) => s.id === id);
    if (!row || row.state === "done") return;
    row.state = state;
    (state === "done" ? this.done : this.started).add(id);
  }

  /** A stage the server itself reaches (checking, fixing, saving). */
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

  override handleToolStart(
    _tool: unknown,
    input: string,
    _runId: string,
    _parent?: string,
    _tags?: string[],
    _meta?: Record<string, unknown>,
    runName?: string,
  ) {
    const name = runName ?? "";
    if (name === "task") {
      let args: { description?: string; subagent_type?: string } = {};
      try {
        args = JSON.parse(input) as typeof args;
      } catch {
        /* free text: match on it below */
      }
      const text = `${args.description ?? ""} ${input}`;
      if ((args.subagent_type ?? text).includes("curriculum-editor")) {
        return this.touch({
          stage: "ordering",
          label: "Putting the concepts in order and grouping them into modules",
          fraction: Math.max(this.state.fraction, 0.03 + SHARE.reading),
        });
      }
      const src = this.sourceIn(text);
      if (src) {
        this.mark(src.id, "reading");
        return this.touch({
          stage: "reading",
          label: this.readingLabel(src.title),
          fraction: this.readingFraction(),
        });
      }
      return this.touch();
    }
    if (name === "write_file" || name === "edit_file") {
      const path = /"file_path"\s*:\s*"([^"]+)"/.exec(input)?.[1] ?? input;
      const cand = /\/work\/candidates\/([^/.]+)/.exec(path)?.[1];
      if (cand) {
        const src = this.sources.find((s) => s.id === cand) ?? this.sourceIn(cand);
        if (src) this.mark(src.id, "done");
        return this.touch({
          stage: "reading",
          label: this.readingLabel(src?.title),
          fraction: this.readingFraction(),
        });
      }
      if (path.includes("/out/curriculum.json"))
        return this.touch({
          stage: "ordering",
          label: "Writing the curriculum",
          fraction: Math.max(this.state.fraction, 0.03 + SHARE.reading + SHARE.ordering),
        });
      return this.touch();
    }
    // Our own source tools name the source they read.
    const src = this.sourceIn(input);
    if (src && this.state.stage !== "ordering") {
      this.mark(src.id, "reading");
      return this.touch({
        stage: "reading",
        label: this.readingLabel(src.title),
        fraction: this.readingFraction(),
      });
    }
    this.touch();
  }

  private readingLabel(title?: string): string {
    const n = this.sources.length;
    const done = this.done.size;
    if (done >= n) return `Read all ${n} ${n === 1 ? "source" : "sources"}`;
    return title
      ? `Reading “${title}” (${Math.min(n, done + 1)} of ${n})`
      : `Reading your sources (${done} of ${n} done)`;
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
