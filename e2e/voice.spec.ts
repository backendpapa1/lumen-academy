import { expect, test } from "@playwright/test";

// V1: push-to-talk and students' voices, with a fake socket, a fake microphone
// and mocked speech endpoints (no server involved). Hold Space in the empty
// lectern → the transcript is taught; a tap still calls the top hand; a
// student's streaming line is spoken chunk by chunk (first clause first).

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  permissions: ["microphone"],
});

/** A valid 0.2 s silent 24 kHz mono WAV. */
function silentWav(): Buffer {
  const n = 4800;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

test("hold Space to teach by voice; tap to call; students speak their lines", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as unknown as { __sent: unknown[] }).__sent = sent;
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 5);
      }
      send(data: string) {
        sent.push(JSON.parse(data));
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  const said: string[] = [];
  await page.route("**/api/speech/status", (r) =>
    r.fulfill({ json: { stt: "ready", tts: "ready", sttProblem: null, ttsProblem: null } }),
  );
  await page.route("**/api/speech/transcribe**", (r) =>
    r.fulfill({ json: { text: "The Merkle root lives in the block header.", ms: 410 } }),
  );
  await page.route("**/api/speech/say", (r) => {
    said.push((r.request().postDataJSON() as { text: string }).text);
    return r.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
  });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  // The demo class is live; the speech status arrives once the class is.
  await page.evaluate(() => window.__lumen!.voice.refreshStatus());
  await expect(page.locator(".hud .lectern .mic")).toBeVisible();

  // Hold Space in the empty lectern: listening, then the transcript is taught.
  await page.locator("#lectern").focus();
  await page.keyboard.down(" ");
  await expect(page.locator(".hud .lectern.listening")).toHaveCount(1);
  await page.waitForTimeout(700);
  await page.keyboard.up(" ");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __sent: Array<{ type: string; payload: { text?: string } }> }
        ).__sent
          .filter((m) => m.type === "teach.message")
          .map((m) => m.payload.text),
      ),
    )
    .toEqual(["The Merkle root lives in the block header."]);

  // A quick tap still calls the top hand (the demo has two hands up).
  await page.keyboard.press(" ");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __sent: Array<{ type: string }> }).__sent.some(
          (m) => m.type === "hand.call",
        ),
      ),
    )
    .toBe(true);

  // A student's line streams in and is spoken: first clause, then the sentence.
  await page.evaluate(() => {
    const L = window.__lumen!;
    L.receive({
      type: "cadet.stream",
      payload: { cadetId: "cdt_1", streamId: "s-voice", delta: "Wait, so the root is " },
    });
    L.receive({
      type: "cadet.stream",
      payload: {
        cadetId: "cdt_1",
        streamId: "s-voice",
        delta: "in the header? Then what's in each block?",
      },
    });
    L.receive({
      type: "cadet.done",
      payload: {
        cadetId: "cdt_1",
        streamId: "s-voice",
        messageId: "msg_v",
        kind: "question",
        mood: "curious",
        text: "Wait, so the root is in the header? Then what's in each block?",
      },
    } as never);
  });
  await expect
    .poll(() => said)
    .toEqual(["Wait,", "so the root is in the header?", "Then what's in each block?"]);
  await expect(page.locator("#speech.shown")).toHaveCount(1);
  await expect(page.locator("#speech p")).toContainText("Then what's in each block?", {
    timeout: 6000,
  });
  expect(errors).toEqual([]);
});
