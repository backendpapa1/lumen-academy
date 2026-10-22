import { expect, test, type Page } from "./test";

// V5: a smoke test per teaching mode, over a faked socket and API (no real
// data or models). Each mode's server messages are scripted below.

async function boot(page: Page, kind: string) {
  await page.route("**/api/**", (r) => {
    const url = r.request().url();
    let body: unknown = [];
    if (url.includes("/meeting"))
      body = {
        parent: "Mrs Adebayo-Clarke",
        child: { id: "cdt_2", name: "Ada Quill" },
        module: "Blocks and Merkle Trees",
        evidence: [
          "- Merkle Trees: understands about 22%; believes: The root is in every transaction.",
        ],
        reply: (r.request().postDataJSON() as { history: unknown[] }).history.length
          ? "Thank you. That's specific, and I can help at home."
          : "Ada came home confused. Why is she struggling?",
        satisfied: (r.request().postDataJSON() as { history: unknown[] }).history.length > 0,
        pushback: false,
      };
    else if (url.includes("/api/campus"))
      body = {
        wings: [],
        streak: {
          current: 1,
          best: 1,
          missedDays: 0,
          taughtToday: true,
          freezes: 0,
          frozenDays: 0,
        },
        xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
        resume: null,
        fading: null,
        best: null,
      };
    else if (url.includes("/confusion"))
      body = [
        { ord: 1, text: "Hashes are paired up.", confused: ["Ada", "Ivy"], cleared: [], fixed: 0 },
        {
          ord: 2,
          text: "Like a knockout bracket: winners meet until one is left.",
          confused: [],
          cleared: ["Ada", "Ivy"],
          fixed: 1,
        },
      ];
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript((mode) => {
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
    localStorage.setItem("lumen.liveClassroom", "cls_fake");
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const cadet = (i: number, name: string, archetype: string) => ({
      id: `cdt_${i}`,
      name,
      archetype,
      seat: i,
      homeworld: "Leeds",
      quirk: "",
      comprehension: 0.3,
      state: "attentive",
    });
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 10);
      }
      private at(ms: number, type: string, payload: unknown) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type, payload }) }), ms);
      }
      send(data: string) {
        const m = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
        sent.push(m);
        if (m.type === "period.start") {
          this.at(20, "period.started", {
            periodId: "per_fake",
            school: { id: "sch_fake", name: "Blockchain" },
            classroom: { id: "cls_fake", name: "Class A" },
            concept: { id: "cpt_1", title: "Merkle trees" },
            concepts: [{ id: "cpt_1", title: "Merkle trees" }],
            cadets: [
              cadet(1, "Ivy Achebe", "connector"),
              cadet(2, "Ada Quill", "lost_signal"),
              cadet(3, "Sora Lee", "skeptic"),
            ],
            plannedMinutes: 12,
            elapsedMs: 0,
            resumed: false,
            paused: false,
            transcript: [],
            xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
            kind: mode,
            hotSeat: mode === "socratic" || mode === "teach_back" ? "cdt_2" : null,
          });
          if (mode === "teach_back")
            this.at(200, "teachback.ready", {
              cadetId: "cdt_2",
              sentences: [
                "So every transaction gets hashed first.",
                "Then the root is stored inside every transaction.",
                "The root ends up in the header.",
              ],
            });
          if (mode === "analogy_lab")
            this.at(200, "analogy.cards", {
              cadetId: "cdt_1",
              cards: [
                "It's like a knockout bracket.",
                "It's like the total at the bottom of a receipt.",
              ],
            });
          if (mode === "eli_ladder")
            this.at(200, "eli.round", {
              round: 1,
              of: 3,
              level: "eli5",
              audience: "a class of 5-year-olds",
            });
          if (mode === "substitute")
            this.at(200, "sub.lesson", {
              lines: [
                "A block has a header and its transactions.",
                "The header holds a copy of every transaction.",
              ],
            });
        }
        if (m.type === "teachback.mark")
          this.at(50, "teachback.result", {
            lines: [
              { text: "So every transaction gets hashed first.", true: true, marked: false },
              {
                text: "Then the root is stored inside every transaction.",
                true: false,
                marked: true,
              },
              { text: "The root ends up in the header.", true: true, marked: false },
            ],
            caught: 1,
            missed: 0,
            falseAlarms: 0,
            score: 1,
          });
        if (m.type === "analogy.judge")
          this.at(50, "analogy.result", {
            i: m.payload.i,
            sound: false,
            right: true,
            reasonScore: 0.8,
            feedback: "Yes: the root isn't a sum.",
            breaks: "A receipt total adds up; a root hashes pairs.",
          });
        if (m.type === "sub.object")
          this.at(50, "sub.objection", {
            i: m.payload.i,
            planted: true,
            correction: "The header is 80 bytes; it holds the Merkle root, not the transactions.",
          });
        if (m.type === "teach.message" && mode === "eli_ladder") {
          this.at(50, "eli.scored", {
            round: 1,
            score: 0.85,
            feedback: "A lovely picture, and true.",
          });
          this.at(80, "eli.round", {
            round: 2,
            of: 3,
            level: "eli15",
            audience: "a class of 15-year-olds",
          });
        }
        if (m.type === "guest.invite")
          this.at(50, "guest.answer", {
            name: "Dr Juniper Vale",
            question: "Where is the root kept?",
            answer: "In the block header: one small hash that commits to every transaction.",
            citations: [{ source: "Mastering Bitcoin ch.9", heading: "Merkle Trees", page: 214 }],
            left: 4,
          });
        if (m.type === "period.end")
          this.at(50, "period.ended", {
            periodId: "per_fake",
            turns: 2,
            minutes: 6,
            costUsd: 0.004,
            mode: {
              kind: mode,
              title: "Socratic",
              lines: ["You asked 4 questions: 2 diagnostic, 1 leading, 1 closed."],
              score: 0.75,
            },
            xp: {
              earned: 30,
              breakdown: [{ kind: "teachingMinute", amount: 30 }],
              standing: { total: 30, rank: "Student Teacher", next: null, progress: 0 },
              rankedUp: false,
            },
          });
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  }, kind);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".b-title")).toHaveText("Merkle trees");
}

const sent = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __sent: Array<{ type: string; payload: unknown }> }).__sent,
  );

test("Socratic: the banner, the hot seat, and the mode's result at the bell", async ({ page }) => {
  await boot(page, "socratic");
  await expect(page.locator(".mode-banner")).toContainText(
    "Questions only. Ada is in the hot seat.",
  );
  await page.screenshot({ path: "docs/screens/v5-socratic.png" });
  await page.getByRole("button", { name: "End class" }).click();
  await expect(page.getByRole("dialog", { name: "Class dismissed" })).toContainText("2 diagnostic");
});

test("teach-back: mark the wrong sentence, check, see the truth", async ({ page }) => {
  await boot(page, "teach_back");
  await page.getByRole("button", { name: /root is stored inside every transaction/ }).click();
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator(".mode-panel")).toContainText("Wrong: caught");
  await page.screenshot({ path: "docs/screens/v5-teach-back.png" });
  expect((await sent(page)).find((m) => m.type === "teachback.mark")?.payload).toEqual({
    wrong: [1],
  });
});

test("analogy lab: call one misleading and say where it breaks", async ({ page }) => {
  await boot(page, "analogy_lab");
  const card = page.locator(".an-card").nth(1);
  await card.getByRole("button", { name: "Misleading" }).click();
  await card.getByRole("textbox").fill("A root isn't a sum of the transactions.");
  await card.getByRole("button", { name: "Judge" }).click();
  await expect(page.locator(".an-card.done")).toContainText("You called it right.");
  await page.screenshot({ path: "docs/screens/v5-analogy-lab.png" });
});

test("ELI ladder: the 5-year-olds are smaller; a round is scored and the next begins", async ({
  page,
}) => {
  await boot(page, "eli_ladder");
  await expect(page.locator(".room.eli5")).toBeVisible();
  await expect(page.locator(".mode-panel")).toContainText("Explain it to a class of 5-year-olds.");
  await page.screenshot({ path: "docs/screens/v5-eli-ladder.png" });
  await page.locator("#lectern").fill("Lots of little boxes get squished into one magic box.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".mode-panel")).toContainText("To 5-year-olds: 85%");
  await expect(page.locator(".mode-panel")).toContainText("Round 2 of 3");
});

test("substitute: lines reveal, O objects, the catch is confirmed", async ({ page }) => {
  await boot(page, "substitute");
  await page.getByRole("button", { name: "Next line" }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("o");
  await expect(page.locator(".sub-line.objected")).toContainText("Good catch");
  await page.screenshot({ path: "docs/screens/v5-substitute.png" });
});

test("guest lecturer: /guest brings an answer from my sources, for me only", async ({ page }) => {
  await boot(page, "class");
  await page.locator("#lectern").fill("/guest Where is the root kept?");
  await page.keyboard.press("Enter");
  const card = page.getByRole("complementary", { name: "Guest lecturer" });
  await expect(card).toContainText("Dr Juniper Vale");
  await expect(card).toContainText("Mastering Bitcoin ch.9 › Merkle Trees (p.214)");
  await page.screenshot({ path: "docs/screens/v5-guest.png" });
});

test("confusion map from the bell", async ({ page }) => {
  await boot(page, "class");
  await page.getByRole("button", { name: "End class" }).click();
  await page.getByRole("button", { name: "What confused them" }).click();
  const map = page.getByRole("dialog", { name: "What confused them" });
  await expect(map).toContainText("Most confusing");
  await expect(map).toContainText("Clearest");
  await page.screenshot({ path: "docs/screens/v5-confusion-map.png" });
});

test("parent meeting: evidence, a question, and a reassured parent", async ({ page }) => {
  await boot(page, "class");
  await page.evaluate(() =>
    window.__lumen!.store.setState({
      route: { name: "meeting", classroomId: "cls_fake", schoolId: "sch_fake" },
    }),
  );
  await expect(page.getByText("Ada came home confused.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Evidence" })).toContainText("believes: The root");
  await page
    .getByRole("textbox", { name: "What you say to the parent" })
    .fill(
      "She thinks the root is in every transaction. I'll re-teach where it lives, with a bracket picture.",
    );
  await page.getByRole("button", { name: "Say it" }).click();
  await expect(page.getByText("They left reassured")).toBeVisible();
  await page.screenshot({ path: "docs/screens/v5-parent-meeting.png" });
});
