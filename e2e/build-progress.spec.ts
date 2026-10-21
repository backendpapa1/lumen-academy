import { expect, test } from "@playwright/test";

// Paul: a progress bar and stage updates for long curriculum builds, so it's
// clearly not hanging, and errors stated plainly. The panel on its own.

test("curriculum build progress: stage, bar, heartbeat, sources, and a plain failure", async ({
  page,
}) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("lumen.onboarded", "1");
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/");
  await page.evaluate(async () => {
    const { buildProgress } = await import("/src/ui/screens/buildProgress.ts");
    const now = Date.now();
    const iso = (s: number) => new Date(now - s * 1000).toISOString();
    const titles = [
      "Volume I — Ethereum, The Foundations",
      "Volume II — Solidity, The Language",
      "Volume III — OpenZeppelin, The Standard Library",
      "Volume IV — Foundry, Tooling and Testing",
      "Volume V — Security",
      "Volume VI — Protocol Design",
      "Volume VII — The dApp Layer",
      "Volume VIII — The Workshop",
    ];
    const base = {
      schoolId: "sch_x",
      status: "building",
      stage: "reading",
      sources: titles.map((title, i) => ({
        id: `src_${i}`,
        title,
        state: i < 4 ? "done" : i === 4 ? "reading" : "waiting",
      })),
      calls: 279,
    };
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:99;background:var(--paper-2);padding:24px;overflow:auto;display:grid;gap:12px;align-content:start";
    document.body.append(wrap);
    const show = (state: object) => {
      const p = buildProgress(() => undefined);
      p.update(state as never);
      wrap.append(p.el);
    };
    show({
      ...base,
      label: "Reading “Volume V — Security” (5 of 8)",
      fraction: 0.47,
      startedAt: iso(18 * 60 + 5),
      lastActivityAt: iso(3),
      waitingSince: iso(102),
    });
    show({
      ...base,
      label: "Putting the concepts in order and grouping them into modules",
      stage: "ordering",
      fraction: 0.84,
      startedAt: iso(25 * 60),
      lastActivityAt: iso(140),
      waitingSince: null,
    });
    show({
      ...base,
      status: "error",
      stage: "failed",
      label: "The build stopped",
      fraction: 0.6,
      startedAt: iso(31 * 60),
      lastActivityAt: iso(60),
      waitingSince: null,
      error:
        "Couldn't reach DeepSeek: check your internet connection, then press Rebuild. What was read so far isn't saved, so it starts over.",
    });
  });
  await expect(page.getByText("Reading “Volume V — Security” (5 of 8)")).toBeVisible();
  await expect(page.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "47");
  await expect(page.getByText(/DeepSeek is working on a long step \(1:4\d\)/)).toBeVisible();
  await expect(page.getByText(/No activity for 2 min/)).toBeVisible();
  await expect(page.getByText(/Couldn't reach DeepSeek/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Rebuild" })).toBeVisible();
  await page.screenshot({ path: "docs/screens/notes-build-progress.png" });
});
