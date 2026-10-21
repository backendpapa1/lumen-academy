import Database from "better-sqlite3";
import { strToU8, zipSync } from "fflate";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnki } from "./anki.js";
import { parsePptx } from "./pptx.js";
import { fetchArticle, readArticle } from "./web.js";
import { captionsToSource, fetchYouTube, parseTimedText, pickTrack, youtubeId } from "./youtube.js";

const FIX = join(import.meta.dirname, "../../test-fixtures/sources");

describe("YouTube captions (V6-01)", () => {
  it("finds the video id in every link shape", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=aircAruvnKk",
      "https://youtu.be/aircAruvnKk?t=40",
      "https://www.youtube.com/shorts/aircAruvnKk",
      "https://m.youtube.com/watch?feature=share&v=aircAruvnKk",
    ])
      expect(youtubeId(u)).toBe("aircAruvnKk");
    expect(youtubeId("https://example.com/watch")).toBeNull();
  });

  it("prefers hand-made English captions, then English auto-captions", () => {
    const t = (languageCode: string, kind?: string) => ({
      baseUrl: languageCode,
      languageCode,
      kind,
    });
    expect(pickTrack([t("ar"), t("en", "asr"), t("en")])?.baseUrl).toBe("en");
    expect(pickTrack([t("ar"), t("en", "asr")])?.kind).toBe("asr");
    expect(pickTrack([t("fr", "asr"), t("de")])?.languageCode).toBe("de");
  });

  it("turns timed text into timestamped sections", () => {
    const lines = parseTimedText(readFileSync(join(FIX, "timedtext.xml"), "utf8"));
    expect(lines).toEqual([
      [0, "Today we look at Merkle trees."],
      [2100, "Each transaction is hashed & paired."],
      [95000, "The root goes in the header."],
    ]);
    const parsed = captionsToSource(lines);
    expect(parsed.sections.map((s) => s.headingPath[0])).toEqual(["0:00", "1:35"]);
  });

  it("fetches the captions only (two requests: the player, then the track)", async () => {
    const urls: string[] = [];
    const fake = (async (u: string | URL) => {
      urls.push(String(u));
      if (String(u).includes("/player"))
        return new Response(
          JSON.stringify({
            videoDetails: { title: "Merkle trees in 5 minutes" },
            playabilityStatus: { status: "OK" },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }],
              },
            },
          }),
        );
      return new Response(readFileSync(join(FIX, "timedtext.xml"), "utf8"));
    }) as typeof fetch;
    const yt = await fetchYouTube("https://youtu.be/aircAruvnKk", fake);
    expect(yt).toMatchObject({ title: "Merkle trees in 5 minutes", language: "en", auto: false });
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => /videoplayback|\.mp4/.test(u))).toBe(false);
  });
});

describe("web articles (V6-02)", () => {
  it("keeps the article and its headings, drops the nav, footer and scripts", () => {
    const html = readFileSync(join(FIX, "article.html"), "utf8");
    const a = readArticle(html, "https://blog.example/merkle");
    const headings = a.parsed.sections.map((s) => s.headingPath.join(" > "));
    expect(headings).toContain("How Merkle trees work > Building the tree");
    expect(headings).toContain("How Merkle trees work > Proving inclusion");
    const all = a.parsed.sections.map((s) => s.text).join("\n");
    expect(all).toContain("the last one is duplicated");
    expect(all).not.toMatch(/Cookie settings|Subscribe|alert/);
  });

  it("drops wiki furniture: [edit] links and footnote markers", () => {
    const html = `<html><body><article><h1>Merkle tree</h1><p>Hash trees are used in peer-to-peer networks.[10] They allow
      efficient verification.[a]</p><div><h2>Uses</h2><span>[edit]</span></div><p>Git uses hash trees.[citation needed]</p></article></body></html>`;
    const all = readArticle(html, "https://en.wikipedia.org/wiki/Merkle_tree")
      .parsed.sections.map((s) => s.text)
      .join("\n");
    expect(all).not.toMatch(/\[(10|a|edit|citation needed)\]/);
    expect(all).toContain("peer-to-peer networks.");
  });

  it("refuses links into this machine or the local network", async () => {
    for (const u of [
      "http://localhost:5174/api/schools",
      "http://192.168.1.4/",
      "file:///etc/passwd",
    ])
      await expect(
        fetchArticle(u, (() => Promise.reject(new Error("no"))) as typeof fetch),
      ).rejects.toThrow(/computer|local network|http/);
  });
});

describe("slides (V6-03)", () => {
  const slide = (title: string, ...body: string[]) =>
    `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody>${body
      .map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  it("one section per slide, headed by its title, with speaker notes", () => {
    const pptx = zipSync({
      "ppt/slides/slide2.xml": strToU8(slide("The Merkle root", "One hash for all transactions")),
      "ppt/slides/slide1.xml": strToU8(slide("Blocks", "A header &amp; transactions")),
      "ppt/slides/slide10.xml": strToU8(slide("Paths", "Sibling hashes up to the root")),
      "ppt/notesSlides/notesSlide2.xml": strToU8(
        "<p:notes><a:p><a:r><a:t>Mention the 80-byte header.</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>",
      ),
    });
    const p = parsePptx(pptx);
    expect(p.sections.map((s) => s.headingPath[0])).toEqual(["Blocks", "The Merkle root", "Paths"]);
    expect(p.sections[0]!.text).toBe("A header & transactions");
    expect(p.sections[1]!.text).toContain("Speaker notes:\nMention the 80-byte header.");
    expect(p.sections[1]!.text).not.toMatch(/\n2$/);
    expect(p.sections[2]!.pageFrom).toBe(10);
  });
});

describe("Anki decks (V6-05)", () => {
  it("each note's front and back is a chunk, headed by its tag or deck; clozes resolve", () => {
    const dir = mkdtempSync(join(tmpdir(), "anki-fix-"));
    const path = join(dir, "c.anki2");
    const db = new Database(path);
    db.exec(`CREATE TABLE col (decks TEXT); CREATE TABLE notes (id INTEGER, flds TEXT, tags TEXT);
             CREATE TABLE cards (nid INTEGER, did INTEGER);`);
    db.prepare("INSERT INTO col VALUES (?)").run(
      JSON.stringify({ "7": { id: 7, name: "Bitcoin\x1fBlocks" } }),
    );
    const add = db.prepare("INSERT INTO notes VALUES (?, ?, ?)");
    add.run(1, "What links blocks?\x1fThe <b>previous header hash</b>", " merkle_trees ");
    add.run(2, "The root is in the {{c1::header}}.\x1f", "");
    db.prepare("INSERT INTO cards VALUES (2, 7)").run();
    db.close();
    const apkg = zipSync({ "collection.anki2": new Uint8Array(readFileSync(path)) });
    const p = parseAnki(apkg);
    expect(p.sections).toEqual([
      { headingPath: ["merkle trees"], text: "Q: What links blocks?\nA: The previous header hash" },
      { headingPath: ["Bitcoin › Blocks"], text: "The root is in the header." },
    ]);
  });

  it("asks for an older-format export when the deck is anki21b", () => {
    expect(() => parseAnki(zipSync({ "collection.anki21b": new Uint8Array([1, 2]) }))).toThrow(
      /Support older Anki versions/,
    );
  });
});
