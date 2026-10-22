import { expect, test } from "./test";

// V4: a living class. Two students talk to each other, a sticker lands on the
// corkboard, and a student moves on in their growth arc. Socket and API faked.

test("peer talk, a sticker and a growth moment", async ({ page }) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
    localStorage.setItem("lumen.liveClassroom", "cls_fake");
    const cadet = (i: number, name: string, archetype: string, extra: object = {}) => ({
      id: `cdt_${i}`,
      name,
      archetype,
      seat: i,
      homeworld: "Leeds",
      quirk: "",
      comprehension: 0.4,
      state: "attentive",
      ...extra,
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
        const m = JSON.parse(data) as { type: string };
        if (m.type !== "period.start") return;
        this.at(20, "period.started", {
          periodId: "per_fake",
          school: { id: "sch_fake", name: "Blockchain" },
          classroom: { id: "cls_fake", name: "Class A" },
          concept: { id: "cpt_1", title: "Merkle trees" },
          concepts: [{ id: "cpt_1", title: "Merkle trees" }],
          cadets: [
            cadet(1, "Ivy Achebe", "connector", { hair: "long braids", interests: ["football"] }),
            cadet(2, "Ada Quill", "lost_signal", {
              hair: "afro",
              arc: { stage: 0, label: "Lost", trigger: "Fix one of their misconceptions." },
            }),
            cadet(3, "Sora Lee", "quiet", {
              arc: { stage: 1, label: "Speaks when asked", trigger: "Call on them." },
            }),
          ],
          plannedMinutes: 15,
          elapsedMs: 60_000,
          resumed: false,
          paused: false,
          transcript: [],
          xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
          stickers: [
            { id: "stk_0", cadetId: "cdt_3", kind: "fixed_confusion", label: "Fixed my confusion" },
          ],
        });
        this.at(400, "peer.started", { speakerId: "cdt_1", listenerId: "cdt_2" });
        const line = "Ada, it's like a knockout bracket: pairs of hashes meet until one is left.";
        this.at(450, "cadet.stream", { cadetId: "cdt_1", streamId: "s1", delta: line });
        this.at(600, "cadet.done", {
          cadetId: "cdt_1",
          streamId: "s1",
          messageId: "m1",
          text: line,
          kind: "claim",
          mood: "proud",
        });
        this.at(700, "sticker", {
          id: "stk_1",
          cadetId: "cdt_2",
          kind: "best_analogy",
          label: "Best analogy!",
        });
        this.at(750, "cadet.arc", {
          cadetId: "cdt_3",
          stage: 2,
          label: "Raises a hand now and then",
          moment: "Sora raised a hand for the first time!",
        });
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  await expect(page.locator("#speech")).toContainText("Ivy Achebe → Ada");
  await expect(page.locator(".room .seat.listening")).toHaveCount(1);
  await expect(page.getByText("Ada gave you a sticker: Best analogy!")).toBeVisible();
  await expect(page.getByText("Sora raised a hand for the first time!")).toBeVisible();
  await expect(page.locator(".corkboard .sticker")).toHaveCount(2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/v4-living-class.png" });

  await page.keyboard.press("r");
  const roster = page.getByRole("complementary", { name: "Roster" });
  await expect(roster.getByText("Raises a hand now and then")).toBeVisible();
  await expect(roster.getByText(/loves football/)).toBeVisible();
});
