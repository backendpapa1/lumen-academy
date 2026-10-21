import { expect, test, type Page } from "@playwright/test";

// The School setup flow end to end in the browser, against a faked server
// (REST via page.route, broadcasts via a fake socket): no models, no database.
// The real routes are covered by apps/server/src/routes/schools.test.ts.

const school = {
  id: "sch_t",
  name: "Optics",
  description: "Light and lenses",
  accent: "#22D3EE",
  emblemUrl: null,
};
const concept = (id: string, title: string, prereq: string[] = []) => ({
  id,
  title,
  summary: `${title} in a sentence.`,
  keyFacts: [`${title} fact one`, `${title} fact two`],
  misconceptions: [],
  prerequisites: prereq,
  citations: ["chk_1"],
  difficulty: 2,
});
const cadets = ["Ada Okafor", "Bo Lindqvist", "Cy Tanaka"].map((name, i) => ({
  id: `cdt_${i}`,
  name,
  archetype: (["skeptic", "connector", "quiet"] as const)[i],
  seat: [4, 7, 10][i],
  homeworld: "Titan",
  quirk: `Quirk of ${name}`,
  comprehension: 0,
  state: "attentive",
  portraitUrl: null,
}));

async function fakeServer(page: Page) {
  const state = { created: false, sources: [] as unknown[], saved: null as unknown };
  await page.addInitScript(() => {
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        (window as unknown as { __push: (m: unknown) => void }).__push = (m) =>
          this.onmessage?.({ data: JSON.stringify(m) });
        setTimeout(() => this.onopen?.(), 5);
      }
      send() {}
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  const push = (m: unknown) =>
    page.evaluate((x) => (window as unknown as { __push: (m: unknown) => void }).__push(x), m);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/schools" && req.method() === "GET")
      return json(
        state.created
          ? [{ ...school, sources: state.sources.length, concepts: 2, classrooms: [] }]
          : [],
      );
    if (p === "/api/schools" && req.method() === "POST") {
      state.created = true;
      return json({ id: school.id }, 201);
    }
    if (p === `/api/schools/${school.id}`)
      return json({ ...school, sources: state.sources, classrooms: [], classroomLimit: 6 });
    if (p === `/api/schools/${school.id}/sources`) {
      setTimeout(async () => {
        await push({
          type: "source.status",
          payload: { schoolId: school.id, sourceId: null, title: "Lens notes", status: "parsing" },
        });
        await new Promise((r) => setTimeout(r, 300));
        state.sources = [
          {
            id: "src_1",
            title: "Lens notes",
            kind: "paste",
            status: "ready",
            error: null,
            pageCount: null,
            chunks: 4,
          },
        ];
        await push({
          type: "source.status",
          payload: { schoolId: school.id, sourceId: "src_1", title: "Lens notes", status: "ready" },
        });
      }, 50);
      return json({ accepted: true, title: "Lens notes" }, 202);
    }
    if (p === `/api/schools/${school.id}/curriculum` && req.method() === "GET")
      return json({
        modules: [
          {
            id: "mod_1",
            title: "Refraction",
            goal: "Explain how lenses bend light.",
            concepts: [
              concept("cpt_1", "Snell's law"),
              concept("cpt_2", "Focal length", ["Snell's law"]),
            ],
          },
        ],
        status: {
          cpt_1: { status: "taught", comprehension: 0.6, turns: 4 },
          cpt_2: { status: "untaught", comprehension: null, turns: 0 },
        },
      });
    if (p === `/api/schools/${school.id}/curriculum` && req.method() === "PUT") {
      state.saved = req.postDataJSON();
      return json({ updated: 2, added: 0, deleted: 0, modulesAdded: 0, modulesDeleted: 0 });
    }
    if (p === `/api/schools/${school.id}/classrooms`) {
      setTimeout(async () => {
        await push({
          type: "registration.started",
          payload: { classroomId: "cls_t", schoolId: school.id, name: "Class A", total: 3 },
        });
        for (const [i, c] of cadets.entries())
          await push({
            type: "registration.arrival",
            payload: { classroomId: "cls_t", cadet: c, index: i + 1, total: 3 },
          });
        await push({
          type: "registration.done",
          payload: { classroomId: "cls_t", status: "active" },
        });
      }, 50);
      return json({ classroomId: "cls_t", name: "Class A", total: 3 }, 202);
    }
    return json({ error: `unmocked ${req.method()} ${p}` }, 404);
  });
  return state;
}

test("found a School → add a source → edit the curriculum → open a class → registration", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = await fakeServer(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // Lobby → Found a School.
  await page.getByRole("button", { name: "Found a new School" }).click();
  const dialog = page.getByRole("dialog", { name: "Found a School" });
  await dialog.getByLabel("Topic").fill("Optics");
  await dialog.getByRole("button", { name: "Found School" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Optics" })).toBeVisible();

  // Sources: paste text, watch it index.
  await page.getByLabel("Title", { exact: true }).fill("Lens notes");
  await page
    .getByLabel("Text", { exact: true })
    .fill("A convex lens bends parallel rays of light to meet at the focal point. ".repeat(3));
  await page.getByRole("button", { name: "Add pasted text" }).click();
  await expect(page.getByText("Ready")).toBeVisible();
  await page.screenshot({ path: "docs/screens/m3-sources.png" });
  await page.getByRole("button", { name: "Next: curriculum" }).click();

  // Curriculum map: statuses, edit a concept, save.
  await expect(page.getByRole("button", { name: /Snell's law\. Taught\./ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Focal length\. Not taught yet\./ })).toBeVisible();
  await page.getByRole("button", { name: /Snell's law/ }).click();
  const title = page.locator("#c-title");
  await title.fill("Snell's law of refraction");
  await title.blur();
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();
  await page.screenshot({ path: "docs/screens/m3-curriculum.png" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Curriculum saved/)).toBeVisible();
  const saved = state.saved as {
    modules: Array<{ concepts: Array<{ title: string; prerequisites: string[] }> }>;
  };
  expect(saved.modules[0]!.concepts.map((c) => c.title)).toEqual([
    "Snell's law of refraction",
    "Focal length",
  ]);
  // The rename followed through to the prerequisite that pointed at it.
  expect(saved.modules[0]!.concepts[1]!.prerequisites).toEqual(["Snell's law of refraction"]);

  // Classes: open one; cadets arrive one by one, then the class assembles.
  await page.getByRole("tab", { name: "Classes" }).click();
  await page.getByRole("button", { name: "Gentle" }).click();
  await page.getByRole("button", { name: "Open a class" }).last().click();
  await expect(page.locator(".enroll .who", { hasText: "Ada Okafor" })).toBeVisible();
  await expect(page.locator(".enroll .who", { hasText: "Cy Tanaka" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Class assembled")).toBeVisible();
  await expect(page.getByText("3 of 3 cadets arrived")).toBeVisible();
  await page.waitForTimeout(1800); // holograms finish materializing
  await page.screenshot({ path: "docs/screens/m3-registration.png" });
  await expect(page.getByRole("button", { name: "Start teaching" })).toBeVisible();
  expect(errors).toEqual([]);
});
