import { expect, test, type Page } from "@playwright/test";

// V6-09: draw on the board with the mouse: two boxes, labels, a rough line
// between them that snaps to an arrow. Done sends the structure (not pixels),
// and a reload brings the diagram back. Socket and API faked.

async function boot(page: Page) {
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
    localStorage.setItem("lumen.liveClassroom", "cls_fake");
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 10);
      }
      send(data: string) {
        const m = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
        sent.push(m);
        if (m.type === "board.diagram")
          localStorage.setItem("__diagram", JSON.stringify(m.payload.diagram));
        if (m.type !== "period.start") return;
        const saved = localStorage.getItem("__diagram");
        const payload = {
          periodId: "per_fake",
          school: { id: "sch_fake", name: "Blockchain" },
          classroom: { id: "cls_fake", name: "Class A" },
          concept: { id: "cpt_1", title: "Merkle trees" },
          concepts: [{ id: "cpt_1", title: "Merkle trees" }],
          cadets: [1, 2, 3].map((i) => ({
            id: `cdt_${i}`,
            name: ["Ivy Achebe", "Ada Quill", "Sora Lee"][i - 1],
            archetype: "skeptic",
            seat: i,
            homeworld: "Leeds",
            quirk: "",
            comprehension: 0.3,
            state: "attentive",
          })),
          plannedMinutes: 15,
          elapsedMs: 0,
          resumed: false,
          paused: false,
          transcript: [],
          xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
          ...(saved ? { diagram: JSON.parse(saved) } : {}),
        };
        setTimeout(
          () => this.onmessage?.({ data: JSON.stringify({ type: "period.started", payload }) }),
          20,
        );
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".b-title")).toHaveText("Merkle trees");
}

test("draw boxes and an arrow on the board; the class gets the structure", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Draw on the board" }).click();
  await expect(page.getByRole("toolbar", { name: "Draw on the board" })).toBeVisible();
  const board = (await page.locator(".room .board-inner").boundingBox())!;
  // Board units (672 × 272) to screen pixels.
  const at = (x: number, y: number) =>
    [board.x + (x / 672) * board.width, board.y + (y / 272) * board.height] as const;
  const dragBox = async (x0: number, y0: number, x1: number, y1: number, label: string) => {
    await page.mouse.move(...at(x0, y0));
    await page.mouse.down();
    await page.mouse.move(...at(x1, y1), { steps: 6 });
    await page.mouse.up();
    const input = page.getByRole("textbox", { name: "Box label" });
    await input.fill(label);
    await input.press("Enter");
  };
  await dragBox(40, 150, 200, 210, "Hash A");
  await dragBox(300, 70, 480, 130, "Merkle root");
  // Pen: a rough line from one box to the other becomes an arrow.
  await page.keyboard.press("p");
  await page.mouse.move(...at(120, 170));
  await page.mouse.down();
  for (const [x, y] of [
    [180, 150],
    [260, 120],
    [330, 100],
    [390, 100],
  ] as const)
    await page.mouse.move(...at(x, y), { steps: 3 });
  await page.mouse.up();
  await expect(page.locator(".diagram .d-edge")).toHaveCount(1);
  await page.waitForTimeout(200);
  await page.screenshot({ path: "docs/screens/v6-board-drawing.png" });
  await page.getByRole("button", { name: "Done · show the class" }).click();

  const sent = await page.evaluate(
    () =>
      (window as unknown as { __sent: Array<{ type: string; payload: { diagram?: unknown } }> })
        .__sent,
  );
  const d = sent.find((m) => m.type === "board.diagram")!.payload.diagram as {
    nodes: Array<{ id: string; label: string }>;
    edges: Array<{ from: string; to: string }>;
  };
  expect(d.nodes.map((n) => n.label)).toEqual(["Hash A", "Merkle root"]);
  expect(d.edges).toHaveLength(1);
  expect(d.edges[0]!.from).toBe(d.nodes[0]!.id);

  // The diagram survives a reload.
  await page.reload();
  await expect(page.locator(".diagram .d-node")).toHaveCount(2);
  await expect(page.locator(".diagram")).toContainText("Merkle root");
});
