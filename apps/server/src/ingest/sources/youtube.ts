import type { ParsedSource, Section } from "../parse.js";

// YouTube (V6-01, ADR-010): the public captions only, never the video. The
// InnerTube player call lists the caption tracks; the timed-text XML gives
// lines with start times. We prefer hand-made English captions, then English
// auto-captions, then whatever exists. Timestamps become page-like anchors
// ("12:40") so references point into the talk.

const PLAYER = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 34,
  hl: "en",
};
const UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
/** Captions are grouped into sections of about this long. */
const WINDOW_MS = 90_000;

export function youtubeId(url: string): string | null {
  const m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(
      url,
    ) ?? /^([\w-]{11})$/.exec(url.trim());
  return m?.[1] ?? null;
}

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { runs?: Array<{ text: string }>; simpleText?: string };
}

export function pickTrack(tracks: Track[]): Track | undefined {
  const en = (t: Track) => t.languageCode === "en" || t.languageCode.startsWith("en-");
  return (
    tracks.find((t) => en(t) && t.kind !== "asr") ??
    tracks.find((t) => en(t)) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks[0]
  );
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** Timed text (format 3 or the classic <text start=…>) to [startMs, text] lines. */
export function parseTimedText(xml: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = decode(m[2]!);
    if (text) out.push([Number(m[1]), text]);
  }
  if (out.length) return out;
  for (const m of xml.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = decode(m[2]!);
    if (text) out.push([Math.round(Number(m[1]) * 1000), text]);
  }
  return out;
}

export const stamp = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Lines grouped into ~90 s sections, each headed by where it starts in the talk. */
export function captionsToSource(lines: Array<[number, string]>): ParsedSource {
  const sections: Section[] = [];
  let start = -1;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) sections.push({ headingPath: [stamp(start)], text: buf.join(" ") });
    buf = [];
  };
  for (const [ms, text] of lines) {
    if (start < 0 || ms - start >= WINDOW_MS) {
      flush();
      start = ms;
    }
    buf.push(text);
  }
  flush();
  return { sections, outline: sections.map((s) => ({ title: s.headingPath[0]!, depth: 1 })) };
}

export interface YouTubeSource {
  title: string;
  url: string;
  language: string;
  auto: boolean;
  parsed: ParsedSource;
}

export async function fetchYouTube(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<YouTubeSource> {
  const id = youtubeId(url);
  if (!id) throw new Error("That doesn't look like a YouTube link.");
  const res = await fetchFn(PLAYER, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ context: { client: CLIENT }, videoId: id }),
  });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}.`);
  const player = (await res.json()) as {
    videoDetails?: { title?: string };
    playabilityStatus?: { status?: string; reason?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
  };
  if (player.playabilityStatus?.status && player.playabilityStatus.status !== "OK")
    throw new Error(player.playabilityStatus.reason ?? "That video isn't available.");
  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  if (!track)
    throw new Error(
      "That video has no captions. Upload its audio instead and it'll be transcribed on this machine.",
    );
  const xml = await (await fetchFn(track.baseUrl, { headers: { "user-agent": UA } })).text();
  const lines = parseTimedText(xml);
  if (!lines.length) throw new Error("The captions came back empty. Try again in a minute.");
  return {
    title: player.videoDetails?.title?.trim() || `YouTube ${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    language: track.languageCode,
    auto: track.kind === "asr",
    parsed: captionsToSource(lines),
  };
}
