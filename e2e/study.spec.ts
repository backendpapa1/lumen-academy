import { expect, test } from "@playwright/test";

// Paul's note: a study session with body doubling. Read my own sources in the
// study hall (the PDF itself, or the indexed text), and keep study notes. API faked.

const CONCEPT = {
  id: "cpt_merkle",
  title: "Merkle root",
  summary: "Pairs of hashes are hashed up to one root.",
  keyFacts: ["The root sits in the block header.", "Pairs are hashed together."],
  misconceptions: ["The root is in every transaction."],
};

/** The study hall's API, faked; `opts` tunes how soon a student leans over. */
async function fakeApi(
  page: import("@playwright/test").Page,
  opts: { interruptEveryMinutes?: number } = {},
) {
  const saved: string[] = [];
  const sessions: Array<Record<string, unknown>> = [];
  const explained: Array<Record<string, unknown>> = [];
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
        prep: [
          {
            classroomId: "cls_a",
            classroomName: "Class A",
            concept: CONCEPT,
            why: "next",
            passages: [
              {
                chunkId: "chk_2",
                sourceId: "src_md",
                sourceTitle: "My lecture notes",
                page: 213,
                heading: "Merkle Trees",
                excerpt: "The merkle root is stored in the block header…",
              },
            ],
            studied: { quotes: 0, explanations: 0 },
          },
        ],
        lookups: [
          {
            id: "msg_q",
            kind: "question",
            text: "Why pairs, not triples?",
            who: "Ada",
            conceptId: "cpt_merkle",
            conceptTitle: "Merkle root",
          },
        ],
        classmates: [
          { id: "cdt_ada", name: "Ada", archetype: "skeptic", hair: "", register: "female" },
          { id: "cdt_bo", name: "Bo", archetype: "pragmatist", hair: "", register: "male" },
        ],
        todayMinutes: 0,
        settings: {
          breakMinutes: 5,
          longStudyMinutes: 90,
          interruptEveryMinutes: opts.interruptEveryMinutes ?? 8,
        },
      };
    else if (url.includes("/chapters"))
      body = {
        chapters: [
          {
            key: "chk_1",
            title: "Merkle Trees",
            pages: "pp. 212–213",
            firstPage: 212,
            firstChunkId: "chk_1",
            chunkIds: ["chk_1", "chk_2"],
            minutes: 4,
            skip: false,
            read: false,
          },
          {
            key: "chk_3",
            title: "Blocks",
            pages: "p. 214",
            firstPage: 214,
            firstChunkId: "chk_3",
            chunkIds: ["chk_3"],
            minutes: 2,
            skip: false,
            read: false,
          },
        ],
      };
    else if (url.includes("/study/question"))
      body = {
        question: {
          concept: { id: "cpt_merkle", title: "Merkle root" },
          cadet: { id: "cdt_ada", name: "Ada", archetype: "skeptic", hair: "", register: "female" },
          text: "Why should I believe Merkle root works the way the book says?",
        },
      };
    else if (url.includes("/study/explain")) {
      explained.push(r.request().postDataJSON() as Record<string, unknown>);
      body = {
        check: {
          verdict: "partly",
          covered: ["Pairs are hashed together."],
          missed: ["The root sits in the block header."],
          wrong: null,
          studentReply: "OK, pairs get hashed. But where does the root end up?",
          tip: "Say where the root is kept.",
        },
        keyFacts: CONCEPT.keyFacts,
        xp: 10,
      };
    } else if (url.includes("/study/quotes"))
      body = { id: "stq_1", concept: { id: "cpt_merkle", title: "Merkle root" } };
    else if (url.endsWith("/api/study/sessions")) {
      sessions.push(r.request().postDataJSON() as Record<string, unknown>);
      body = { id: "sts_1" };
    } else if (url.includes("/api/study/sessions/"))
      body = { minutes: 0, xp: 0, todayMinutes: 0, streak: 1, countsForStreak: false };
    else if (url.includes("/sources/src_pdf/text") || url.includes("/sources/src_md/text"))
      body = {
        title: "Mastering Bitcoin",
        url: null,
        sections: [
          {
            id: "chk_1",
            heading: "Chapter 9 > Merkle Trees",
            page: 212,
            text: "A merkle tree, also known as a binary hash tree, is a data structure used for efficiently summarizing and verifying the integrity of large sets of data.\n\nMerkle trees are binary trees containing cryptographic hashes.",
          },
          {
            id: "chk_2",
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
  return { saved, sessions, explained };
}

test("study session: read a source, quote it into notes, notes save", async ({ page }) => {
  const { saved } = await fakeApi(page);
  const reader = page.getByRole("region", { name: "Your sources" });
  // The PDF opens in the browser's own viewer first.
  await expect(reader.locator("iframe.sh-pdf")).toHaveAttribute("src", /sources\/src_pdf\/file/);
  await reader.getByRole("button", { name: "Text" }).click();
  await expect(reader.getByRole("heading", { name: "Merkle Trees" })).toBeVisible();
  await expect(reader.getByText("p. 213")).toBeVisible();

  // Select a sentence and quote it into the notebook.
  await reader.getByText(/The merkle root is stored in the block header/).selectText();
  await reader.getByRole("button", { name: "Add selection to notes" }).click();
  await page.getByRole("tab", { name: "Notes" }).click();
  const notes = page.getByRole("textbox", { name: "Study notes for Blockchain" });
  await expect(notes).toHaveValue(
    /> The merkle root is stored in the block header.*\n> \(Mastering Bitcoin, p\. 213 · Merkle root\)/,
  );
  await notes.press("End");
  await notes.pressSequentially("So the root lives in the header, not in each transaction.");
  await expect(page.getByText("Saved", { exact: false })).toBeVisible();
  await expect.poll(() => saved.at(-1) ?? "").toContain("not in each transaction");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/screens/notes-study-session.png" });
});

test("study hall: an intention, a timer that pauses, prep for class, and a student's question", async ({
  page,
}) => {
  const { sessions, explained } = await fakeApi(page, { interruptEveryMinutes: 0.03 });
  const reader = page.getByRole("region", { name: "Your sources" });
  await reader.getByRole("button", { name: "Text" }).click();
  await expect(reader.getByRole("combobox", { name: "Chapter" })).toContainText(
    "Merkle Trees · about 4 min",
  );

  // Prep: the concept Class A meets next, and its passage opens in the reader.
  await expect(page.getByText("Class A meets next")).toBeVisible();
  await page.getByRole("button", { name: /My lecture notes · Merkle Trees · p\. 213/ }).click();
  await expect(page.getByText("Look up before class")).toBeVisible();
  await expect(page.getByText("Why pairs, not triples?")).toBeVisible();

  // Start with an intention; Pause really pauses (the old button missed clicks).
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: "Prep Merkle root for Class A" }).click();
  await expect(page.getByText("Now: Prep Merkle root for Class A")).toBeVisible();
  expect(sessions[0]).toMatchObject({
    schoolId: "sch_a",
    intention: "Prep Merkle root for Class A",
  });
  const timer = page.getByRole("timer");
  await expect(timer).not.toHaveText("25:00");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Carry on" })).toBeVisible();
  const held = await timer.textContent();
  await page.waitForTimeout(1600);
  await expect(timer).toHaveText(held!);
  await page.getByRole("button", { name: "Carry on" }).click();

  // A student from my class leans over; I answer; the coach's reply comes back.
  const bubble = page.locator(".sh-buddy");
  await expect(bubble).toContainText("Ada leans over", { timeout: 8000 });
  await bubble.getByRole("textbox").fill("Pairs of hashes get hashed together until one is left.");
  await bubble.getByRole("button", { name: "Answer" }).click();
  await expect(bubble).toContainText("But where does the root end up?");
  await expect(bubble).toContainText("1 of 2 key facts");
  expect(explained[0]).toMatchObject({
    conceptId: "cpt_merkle",
    kind: "answer",
    cadetId: "cdt_ada",
  });
  await page.screenshot({ path: "docs/screens/study-hall-prep.png" });
  await bubble.getByRole("button", { name: "Back to reading" }).click();

  // Finish early: "Did you?"
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByRole("dialog", { name: "Did you?" })).toBeVisible();
  await page.getByRole("button", { name: "Partly" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});
