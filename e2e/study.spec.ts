import { expect, test } from "@playwright/test";

// Paul's note: a study session with body doubling. Read my own sources in the
// study hall (the PDF itself, or the indexed text), and keep study notes. API faked.

test("study session: read a source, quote it into notes, notes save", async ({ page }) => {
  const saved: string[] = [];
  await page.route("**/api/**", async (r) => {
    const url = r.request().url();
    let body: unknown = [];
    if (/\/api\/schools$/.test(url))
      body = [
        {
          id: "sch_a",
          name: "Blockchain",
          description: null,
          accent: "#0E8A80",
          emblemUrl: null,
          sources: 2,
          concepts: 12,
          classrooms: [],
        },
      ];
    else if (url.endsWith("/api/schools/sch_a/study"))
      body = {
        school: { id: "sch_a", name: "Blockchain" },
        sources: [
          {
            id: "src_pdf",
            title: "Mastering Bitcoin",
            kind: "pdf",
            url: null,
            pages: 300,
            original: true,
          },
          {
            id: "src_md",
            title: "My lecture notes",
            kind: "md",
            url: null,
            pages: null,
            original: false,
          },
        ],
        notes: { body: "", updatedAt: null },
      };
    else if (url.includes("/sources/src_pdf/text") || url.includes("/sources/src_md/text"))
      body = {
        title: "Mastering Bitcoin",
        url: null,
        sections: [
          {
            heading: "Chapter 9 > Merkle Trees",
            page: 212,
            text: "A merkle tree, also known as a binary hash tree, is a data structure used for efficiently summarizing and verifying the integrity of large sets of data.\n\nMerkle trees are binary trees containing cryptographic hashes.",
          },
          {
            heading: "Chapter 9 > Merkle Trees",
            page: 213,
            text: "The merkle root is stored in the block header, and summarizes all the transactions in the block.",
          },
        ],
      };
    else if (url.includes("/study/notes")) {
      saved.push((r.request().postDataJSON() as { body: string }).body);
      body = { updatedAt: "2026-10-21T18:30:00Z" };
    } else if (url.includes("/api/campus"))
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
    else if (url.includes("/api/looks")) body = {};
    if (url.includes("/file"))
      return r.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" });
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen.onboarded", "1");
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Study hall" }).click();
  const reader = page.getByRole("region", { name: "Your sources" });
  // The PDF opens in the browser's own viewer first.
  await expect(reader.locator("iframe.sh-pdf")).toHaveAttribute("src", /sources\/src_pdf\/file/);
  await reader.getByRole("button", { name: "Text" }).click();
  await expect(reader.getByRole("heading", { name: "Merkle Trees" })).toBeVisible();
  await expect(reader.getByText("p. 213")).toBeVisible();

  // Select a sentence and quote it into the notebook.
  await reader.getByText(/The merkle root is stored in the block header/).selectText();
  await reader.getByRole("button", { name: "Add selection to notes" }).click();
  const notes = page.getByRole("textbox", { name: "Study notes for Blockchain" });
  await expect(notes).toHaveValue(
    /> The merkle root is stored in the block header.*\n> \(Mastering Bitcoin, p\. 213\)/,
  );
  await notes.press("End");
  await notes.pressSequentially("So the root lives in the header, not in each transaction.");
  await expect(page.getByText("Saved", { exact: false })).toBeVisible();
  await expect.poll(() => saved.at(-1) ?? "").toContain("not in each transaction");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/screens/notes-study-session.png" });
});
