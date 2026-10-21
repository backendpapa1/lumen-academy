import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { parseMarkdown, type ParsedSource } from "../parse.js";

// Web articles (V6-02): one fetch of the URL I pasted, the readable part pulled
// out with Mozilla Readability (no scripts run), headings kept as Markdown so
// sections and references follow the article's own structure.

const MAX_BYTES = 5_000_000;

/** The article's HTML as Markdown-ish text: headings, paragraphs, list items, quotes, code. */
export function articleToMarkdown(html: string): string {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const node of [...el.children]) {
      const tag = node.tagName.toLowerCase();
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/^h[1-6]$/.test(tag)) {
        if (text) out.push(`${"#".repeat(Number(tag[1]))} ${text}`, "");
      } else if (tag === "p" || tag === "blockquote" || tag === "figcaption") {
        if (text) out.push(tag === "blockquote" ? `> ${text}` : text, "");
      } else if (tag === "li") {
        if (text) out.push(`- ${text}`);
      } else if (tag === "pre") {
        const code = node.textContent ?? "";
        if (code.trim()) out.push("```", code.trimEnd(), "```", "");
      } else if (tag === "table") {
        for (const row of node.querySelectorAll("tr")) {
          const cells = [...row.children].map((c) =>
            (c.textContent ?? "").replace(/\s+/g, " ").trim(),
          );
          if (cells.some(Boolean)) out.push(cells.join(" | "));
        }
        out.push("");
      } else walk(node);
    }
  };
  walk(doc.body);
  return (
    out
      .join("\n")
      // Wiki furniture: "[edit]" links and footnote markers like [10] or [a].
      .replace(/^\[edit\]$/gm, "")
      .replace(/\[(\d{1,3}|[a-z]|citation needed|edit)\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export interface WebSource {
  title: string;
  url: string;
  parsed: ParsedSource;
}

/** Parses an already-fetched page (exported for tests). */
export function readArticle(html: string, url: string): WebSource {
  // No scripts, no subresources: JSDOM only parses.
  const dom = new JSDOM(html, { url });
  // The page's own heading beats the <title> (which carries " | Site name").
  const h1 = dom.window.document.querySelector("article h1, main h1, h1")?.textContent?.trim();
  const article = new Readability(dom.window.document).parse();
  if (!article?.content) throw new Error("Couldn't find an article on that page.");
  const title = (
    h1 ||
    article.title?.replace(/\s+[|–—-]\s+[^|–—-]+$/, "") ||
    new URL(url).hostname
  ).trim();
  let md = articleToMarkdown(article.content);
  // Readability lifts the article's own title out of the content: put it back on
  // top, so every section sits under it and none is left without a heading.
  if (!md.startsWith("# ")) md = `# ${title}\n\n${md}`;
  const parsed = parseMarkdown(md);
  if (!parsed.sections.length) throw new Error("That page has no readable text.");
  return { title, url, parsed };
}

export async function fetchArticle(url: string, fetchFn: typeof fetch = fetch): Promise<WebSource> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("That isn't a web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("Only http(s) links, please.");
  // Never reach into this machine or the local network from a pasted link.
  if (
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?)/i.test(
      u.hostname,
    )
  )
    throw new Error("That link points at this computer or your local network.");
  const res = await fetchFn(u, {
    headers: { "user-agent": "Mozilla/5.0 (Lumen Academy reader)", accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (!/html|xml/.test(type))
    throw new Error("That link isn't a web page (try uploading the file).");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error("That page is too big to read.");
  return readArticle(new TextDecoder().decode(buf), res.url || u.href);
}
