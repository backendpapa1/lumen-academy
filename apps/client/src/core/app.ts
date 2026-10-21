import { UPGRADES, type Diagram, type PeriodKind, type ServerMessage } from "@lumen/shared";
import {
  api,
  type ArchivedSchool,
  type CampusView,
  type SchoolDetail,
  type SchoolSummary,
} from "./api";
import { applyServerMessage, dismissToast, type ParkedItem } from "./classroom";
import { serverEvents } from "./bus";
import { applySetupMessage } from "./setup";
import { Net } from "./net";
import { rhythm } from "./rhythm";
import { rememberHair } from "../ui/peeps/peep";
import { store } from "./store";

// The one place that talks to the server: actions in, server messages applied
// to the store. Phaser, Three and the DOM overlays only read the store and call these.

let net: Net | null = null;
const TOAST_MS = 5000;

// The classroom you're in survives a reload: reopening the tab rejoins it,
// and the server picks the unfinished period back up (paused).
const LAST_CLASS_KEY = "lumen.liveClassroom";
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_CLASS_KEY, id);
    else localStorage.removeItem(LAST_CLASS_KEY);
  } catch {
    /* storage blocked: reload just returns to the class picker */
  }
};

/** A period is open in this classroom (resume it, don't check in). */
function inProgress(classroomId: string): boolean {
  const { schools, campus } = store.getState().setup;
  if (campus?.resume?.inProgress && campus.resume.classroomId === classroomId) return true;
  return !!schools?.some((s) =>
    s.classrooms.some((c) => c.id === classroomId && c.openPeriodElapsedMs != null),
  );
}

const BREAK_KEY = "lumen.break";
function saveBreak(b: { periodId: string; until: number } | null) {
  try {
    if (b) sessionStorage.setItem(BREAK_KEY, JSON.stringify(b));
    else sessionStorage.removeItem(BREAK_KEY);
  } catch {
    /* storage blocked: a reload shows the ordinary pause card */
  }
}
function loadBreak(): { periodId: string; until: number } | null {
  try {
    const raw = sessionStorage.getItem(BREAK_KEY);
    return raw ? (JSON.parse(raw) as { periodId: string; until: number }) : null;
  } catch {
    return null;
  }
}

function receive(m: ServerMessage) {
  // V4-07: learn each student's hair before anything draws them.
  if (m.type === "period.started") rememberHair(m.payload.cadets.map((c) => [c.id, c.hair]));
  if (m.type === "registration.arrival") rememberHair([[m.payload.cadet.id, m.payload.cadet.hair]]);
  if (m.type === "cadet.joined") rememberHair([[m.payload.cadet.id, m.payload.cadet.hair]]);
  // V7-01: the class notices what's new in the room.
  if (m.type === "period.started" && m.payload.newUpgrades?.length) {
    const kids = m.payload.cadets;
    m.payload.newUpgrades.forEach((item, i) => {
      const u = UPGRADES.find((x) => x.item === item);
      const who = kids[(i * 3 + 1) % Math.max(1, kids.length)]?.name.split(" ")[0];
      if (u && who) setTimeout(() => app.notify(`${who}: “${u.react}”`), 1500 + i * 2500);
    });
  }
  // V4-03/06: growth moments and stickers get their own little cheer.
  if (m.type === "cadet.arc" && m.payload.moment)
    queueMicrotask(() => app.notify(m.payload.moment));
  if (m.type === "sticker") {
    const who =
      store.getState().classroom.cadets[m.payload.cadetId]?.name.split(" ")[0] ?? "A student";
    queueMicrotask(() => app.notify(`${who} gave you a sticker: ${m.payload.label}`));
  }
  const wasStarting = store.getState().classroom.status === "starting";
  store.setState((s) => ({
    classroom: applyServerMessage(s.classroom, m),
    setup: applySetupMessage(s.setup, m),
  }));
  serverEvents.emit("message", m);
  if (m.type === "source.status" && (m.payload.status === "ready" || m.payload.status === "error"))
    void app.refreshSchool().catch(() => undefined);
  if (m.type === "curriculum.status" && m.payload.status !== "building")
    void app.refreshSchool().catch(() => undefined);
  // A class that can't start (archived, no cadets…) sends you back to the picker.
  if (m.type === "error" && wasStarting) {
    remember(null);
    store.setState({ route: { name: "boot" } });
  }
  if (m.type === "period.started") {
    remember(m.payload.classroom.id);
    void app.loadParking(m.payload.school.id);
    // A reload during a break comes back to the break, not a cold pause card.
    const b = loadBreak();
    if (b && b.periodId === m.payload.periodId && m.payload.paused)
      store.setState((s) => ({ classroom: { ...s.classroom, breakUntil: b.until } }));
    else saveBreak(null);
    const { kind, energy, resumed, plannedMinutes } = m.payload;
    if (!resumed && kind === "micro")
      app.notify(
        `Micro-lesson: one idea, one question. The bell rings at ${plannedMinutes} minutes.`,
      );
    else if (!resumed && energy === "high")
      app.notify("Feeling sharp? Press F for Hyperfocus: lights down, harder questions.");
    else if (!resumed && energy === "low")
      app.notify("A gentle class today: shorter questions, no surprises.");
  }
  if (m.type === "period.ended") {
    remember(null);
    const school = store.getState().classroom.school?.id;
    if (school) void app.loadParking(school, m.payload.periodId);
  }
  if (m.type === "toast" || m.type === "error") {
    const id = store.getState().classroom.toasts.at(-1)?.id;
    if (id !== undefined)
      setTimeout(
        () => store.setState((s) => ({ classroom: dismissToast(s.classroom, id) })),
        TOAST_MS,
      );
  }
}

function ensureNet(): Net {
  if (net) return net;
  net = new Net(receive, (status) => store.setState({ net: status }));
  net.connect();
  return net;
}

export const app = {
  /** Connects at launch so School setup progress arrives on every screen. */
  connect() {
    ensureNet();
  },
  async loadSchools() {
    void api
      .get<Record<string, string>>("/api/looks")
      .then((looks) => rememberHair(Object.entries(looks)))
      .catch(() => undefined);
    const [schools, campus, archived] = await Promise.all([
      api.get<SchoolSummary[]>("/api/schools"),
      api.get<CampusView>("/api/campus"),
      api.get<ArchivedSchool[]>("/api/schools/archived"),
    ]);
    store.setState((s) => ({ setup: { ...s.setup, schools, campus, archived } }));
    return schools;
  },
  /** Puts a School away: off the lobby and campus, nothing deleted. */
  async archiveSchool(id: string, name: string) {
    await api.post(`/api/schools/${id}/archive`);
    this.backToBoot();
    this.notify(`${name} is archived. Restore it any time from Archived on the lobby.`);
  },
  async restoreSchool(id: string, name: string) {
    await api.post(`/api/schools/${id}/restore`);
    await this.loadSchools();
    this.notify(`${name} is back on your campus.`);
  },
  async createSchool(name: string, description: string) {
    const { id } = await api.post<{ id: string }>("/api/schools", {
      name,
      description: description || undefined,
    });
    this.openSchool(id, "sources");
    return id;
  },
  openSchool(
    schoolId: string,
    tab: "sources" | "curriculum" | "classes" | "knowledge" = "sources",
  ) {
    store.setState((s) => ({
      route: { name: "school", schoolId, tab },
      setup:
        s.setup.school?.id === schoolId
          ? s.setup
          : { ...s.setup, school: null, sourceJobs: {}, curriculumJob: null },
    }));
    void this.refreshSchool().catch((e: Error) => this.notify(e.message, "error"));
  },
  async refreshSchool() {
    const route = store.getState().route;
    if (route.name !== "school") return;
    const school = await api.get<SchoolDetail>(`/api/schools/${route.schoolId}`);
    store.setState((s) => ({ setup: { ...s.setup, school } }));
  },
  async openClassroom(schoolId: string, difficulty: "gentle" | "standard" | "ruthless") {
    const r = await api.post<{ classroomId: string; name: string; total: number }>(
      `/api/schools/${schoolId}/classrooms`,
      { difficulty },
    );
    store.setState((s) => ({
      route: { name: "registration", classroomId: r.classroomId, schoolId },
      setup: {
        ...s.setup,
        // registration.started may already have arrived; keep its arrivals.
        registration:
          s.setup.registration?.classroomId === r.classroomId
            ? s.setup.registration
            : {
                classroomId: r.classroomId,
                schoolId,
                name: r.name,
                total: r.total,
                arrivals: [],
                status: "arriving",
              },
      },
    }));
  },
  /**
   * Start (or rejoin) a class. A new period first asks how my energy is
   * (V3-02) unless I've turned that off; a period already in progress never asks.
   */
  startClass(
    classroomId: string,
    opts: {
      minutes?: number;
      conceptId?: string;
      kind?: PeriodKind;
      cadetId?: string;
      energy?: "low" | "ok" | "high";
      ask?: boolean;
    } = {},
  ) {
    const { ask, ...start } = opts;
    if (ask !== false && !start.energy && rhythm.prefs.checkIn && !inProgress(classroomId)) {
      void import("../ui/screens/checkin").then(async (m) => {
        const r = await m.energyCheckIn({ micro: start.kind === "micro" });
        if (!r) return;
        this.startClass(classroomId, {
          ...start,
          ...(r.energy ? { energy: r.energy } : {}),
          ...(r.micro ? { kind: "micro" as const } : {}),
          ask: false,
        });
      });
      return;
    }
    store.setState((s) => ({
      route: { name: "classroom", classroomId },
      classroom: { ...s.classroom, status: "starting" },
    }));
    ensureNet().send("period.start", { classroomId, ...start });
  },
  teach(text: string, opts: { spoken?: boolean } = {}) {
    const t = text.trim();
    if (t.startsWith("/")) return this.command(t);
    if (!t || store.getState().classroom.status !== "live") return;
    store.setState((s) => ({
      classroom: { ...s.classroom, lastSendAt: Date.now(), thinking: true },
    }));
    ensureNet().send("teach.message", { text: t, ...(opts.spoken ? { spoken: true } : {}) });
  },
  call(cadetId: string) {
    ensureNet().send("hand.call", { cadetId });
  },
  setConcept(conceptId: string) {
    ensureNet().send("concept.set", { conceptId });
  },
  pause() {
    if (store.getState().classroom.status === "live") ensureNet().send("period.pause", {});
  },
  resume() {
    if (store.getState().classroom.status !== "live") return;
    saveBreak(null);
    ensureNet().send("period.resume", {});
  },
  /** V3-05: a Pomodoro break pauses the class; nothing runs on the server meanwhile. */
  takeBreak(minutes: number) {
    const c = store.getState().classroom;
    if (c.status !== "live" || c.clock.paused) return;
    const until = Date.now() + minutes * 60_000;
    if (c.periodId) saveBreak({ periodId: c.periodId, until });
    store.setState((s) => ({ classroom: { ...s.classroom, breakUntil: until } }));
    this.pause();
  },
  /**
   * Lectern quick actions (docs/02 §3.3): /board <text> (T-9, "/board clear"),
   * /focus (Hyperfocus), /recap (last time…), /assign, /help.
   */
  command(text: string) {
    const [cmd = ""] = text.slice(1).split(/\s+/);
    const arg = text.slice(1 + cmd.length).trim();
    const c = store.getState().classroom;
    switch (cmd.toLowerCase()) {
      case "board":
        ensureNet().send("board.set", {
          text: arg.toLowerCase() === "clear" ? "" : arg.replace(/\s*\|\s*/g, "\n"),
        });
        return;
      case "focus":
        return void import("./hyperfocus").then((m) => m.toggleHyperfocus());
      case "recap": {
        // The HUD shows the card when recap changes, so clear it and set it again.
        const text = c.recap ?? "No recap from last time yet: this is the class's first period.";
        store.setState((st) => ({ classroom: { ...st.classroom, recap: undefined } }));
        queueMicrotask(() =>
          store.setState((st) => ({ classroom: { ...st.classroom, recap: text } })),
        );
        return;
      }
      case "assign":
        return this.notify("At the bell, “Set homework” takes you straight to the Class Desk.");
      case "source":
        ensureNet().send("source.check", arg ? { text: arg } : {});
        return;
      case "guest":
        ensureNet().send("guest.invite", arg ? { question: arg } : {});
        return;
      case "park":
        if (!arg) return this.notify("Type the thought after /park, then Enter.");
        return void this.park(arg);
      default:
        return this.notify(
          "Lectern commands: /board <text> (| for a new line, /board clear) · /park <thought> · /source · /guest <question> · /focus · /recap · /assign",
        );
    }
  },
  setHyperfocus(on: boolean) {
    ensureNet().send("focus.toggle", { on });
    this.notify(on ? "Hyperfocus on: lights down, sharper questions." : "Hyperfocus off.");
  },
  /** T-7: more time after the bell. */
  extend(minutes = 5) {
    if (store.getState().classroom.status === "live")
      ensureNet().send("period.extend", { minutes });
  },
  togglePause() {
    if (store.getState().classroom.clock.paused) this.resume();
    else this.pause();
  },
  /** After a reload: rejoin the classroom that was live, if any. */
  rejoin(): boolean {
    let id: string | null;
    try {
      id = localStorage.getItem(LAST_CLASS_KEY);
    } catch {
      return false;
    }
    if (!id) return false;
    this.startClass(id, { ask: false });
    return true;
  },
  endClass() {
    store.setState((s) => ({ classroom: { ...s.classroom, status: "ending" } }));
    ensureNet().send("period.end", {});
  },
  /** The Class Desk: assignments, grading and exams for one class. */
  openDesk(
    schoolId: string,
    classroomId: string,
    tab: "assignments" | "exams" = "assignments",
    assignmentId?: string,
  ) {
    store.setState({
      route: {
        name: "desk",
        schoolId,
        classroomId,
        tab,
        ...(assignmentId ? { assignmentId } : {}),
      },
    });
  },
  /** Re-teach (E-5): a focused period on one concept. */
  reteach(classroomId: string, conceptId: string) {
    this.startClass(classroomId, { conceptId });
  },
  /** Exit ticket: ✓ (true) or ✗ (false) on one cadet's statement. */
  markExitTicket(ticketId: string, verdict: boolean) {
    store.setState((s) => ({
      classroom: s.classroom.exit
        ? {
            ...s.classroom,
            exit: {
              ...s.classroom.exit,
              tickets: s.classroom.exit.tickets.map((t) =>
                t.id === ticketId ? { ...t, verdict } : t,
              ),
            },
          }
        : s.classroom,
    }));
    ensureNet().send("exit.mark", { ticketId, verdict });
  },
  /** My answer to a pop quiz, or my verdict on a glitch (wrong = I caught it). */
  answerEvent(eventId: string, answer: { text?: string; wrong?: boolean }) {
    store.setState((s) =>
      s.classroom.event?.id === eventId
        ? { classroom: { ...s.classroom, event: { ...s.classroom.event, sent: true } } }
        : {},
    );
    ensureNet().send("event.answer", { eventId, ...answer });
  },
  dismissEvent() {
    store.setState((s) => {
      const classroom = { ...s.classroom };
      delete classroom.event;
      return { classroom };
    });
  },
  /** V6-09: keep the diagram I drew (the class reacts to it as a teaching turn). */
  saveDiagram(diagram: Diagram) {
    store.setState((s) => ({ classroom: { ...s.classroom, diagram } }));
    ensureNet().send("board.diagram", { diagram });
  },
  dismissSource() {
    store.setState((s) => ({ classroom: { ...s.classroom, sourcePassage: null } }));
  },
  dismissGuest() {
    store.setState((s) => ({ classroom: { ...s.classroom, guest: null } }));
  },
  /** V5-04: my verdict on an analogy, and where it breaks. */
  judgeAnalogy(i: number, verdict: "good" | "misleading", reason: string) {
    ensureNet().send("analogy.judge", { i, verdict, reason });
  },
  /** V5-08: object to the substitute's line i; finish the lesson. */
  objectToSub(i: number) {
    ensureNet().send("sub.object", { i });
  },
  finishSub() {
    ensureNet().send("sub.finish", {});
  },
  /** V5-03: the teach-back sentences I think are wrong. */
  markTeachBack(wrong: number[]) {
    ensureNet().send("teachback.mark", { wrong });
  },
  finishExitTickets(periodId: string) {
    ensureNet().send("exit.done", { periodId });
  },
  /** V3-04: file a stray thought for later, without leaving the class. */
  async park(text: string, schoolId = store.getState().classroom.school?.id) {
    if (!schoolId) return;
    try {
      const r = await api.post<ParkedItem & { open: number }>(`/api/schools/${schoolId}/parking`, {
        text,
        ...(store.getState().classroom.periodId
          ? { periodId: store.getState().classroom.periodId }
          : {}),
      });
      store.setState((s) => ({
        classroom: {
          ...s.classroom,
          parking: { open: r.open, items: [...s.classroom.parking.items, r] },
        },
      }));
      this.notify("Parked. It'll be waiting for you at the bell.");
    } catch (e) {
      this.notify((e as Error).message, "error");
    }
  },
  /** The School's open count, and (with a period) that period's thoughts for the bell. */
  async loadParking(schoolId: string, periodId?: string) {
    try {
      const open = await api.get<ParkedItem[]>(`/api/schools/${schoolId}/parking`);
      const items = periodId
        ? await api.get<ParkedItem[]>(
            `/api/schools/${schoolId}/parking?status=all&periodId=${encodeURIComponent(periodId)}`,
          )
        : store.getState().classroom.parking.items;
      store.setState((s) => ({
        classroom: { ...s.classroom, parking: { open: open.length, items } },
      }));
    } catch {
      /* the lot is a nicety; the class goes on without it */
    }
  },
  async resolveParked(item: ParkedItem, status: ParkedItem["status"]) {
    try {
      await api.patch(`/api/parking/${item.id}`, { status });
    } catch (e) {
      return this.notify((e as Error).message, "error");
    }
    store.setState((s) => ({
      classroom: {
        ...s.classroom,
        parking: {
          open: Math.max(0, s.classroom.parking.open - (status === "open" ? -1 : 1)),
          items: s.classroom.parking.items.map((p) => (p.id === item.id ? { ...p, status } : p)),
        },
      },
    }));
    const school = store.getState().classroom.school?.id;
    if (status === "concept" && school)
      store.setState({
        route: { name: "school", schoolId: school, tab: "curriculum", newConcept: item.text },
      });
  },
  /** A client-side toast, same look and lifetime as the server's. */
  notify(text: string, level: "info" | "warn" | "error" = "info") {
    receive({ type: "toast", payload: { level, text } });
  },
  select(cadetId: string | null) {
    if (store.getState().selectedId !== cadetId) store.setState({ selectedId: cadetId });
  },
  backToBoot() {
    remember(null);
    store.setState({ route: { name: "boot" } });
    void this.loadSchools().catch(() => undefined);
  },
};
