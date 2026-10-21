import { describe, expect, it } from "vitest";
import { dnsServers, makeLookup, setupAndroid } from "./android.js";

const lookupWith = (table: Record<string, string[]>) => {
  const asked: string[] = [];
  const fallback = ((host: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => {
    asked.push(`system:${host}`);
    cb(null, "127.0.0.1", 4);
  }) as never;
  const lookup = makeLookup(async (host, family) => {
    asked.push(`${host}/${family}`);
    const hit = table[`${host}/${family}`];
    if (!hit) throw Object.assign(new Error("none"), { code: "ENODATA" });
    return hit;
  }, fallback);
  const call = (host: string, opts: object | number = {}) =>
    new Promise<{ err: unknown; address: unknown; family?: number }>((ok) =>
      lookup(host, opts, (err, address, family) => ok({ err, address, family })),
    );
  return { call, asked };
};

describe("Android name resolution (ADR-012)", () => {
  it("resolves A first, then AAAA, and answers in dns.lookup's shapes", async () => {
    const { call, asked } = lookupWith({ "api.deepseek.com/4": ["1.2.3.4", "1.2.3.5"] });
    expect(await call("api.deepseek.com")).toEqual({ err: null, address: "1.2.3.4", family: 4 });
    expect((await call("api.deepseek.com", { all: true })).address).toEqual([
      { address: "1.2.3.4", family: 4 },
      { address: "1.2.3.5", family: 4 },
    ]);
    const v6 = lookupWith({ "v6.example/6": ["2001:db8::1"] });
    expect(await v6.call("v6.example")).toMatchObject({ address: "2001:db8::1", family: 6 });
    expect(v6.asked).toEqual(["v6.example/4", "v6.example/6"]);
    expect(asked[0]).toBe("api.deepseek.com/4");
  });

  it("leaves localhost and IP literals to the system, and reports a miss as an error", async () => {
    const { call, asked } = lookupWith({});
    await call("127.0.0.1");
    await call("localhost", 4);
    expect(asked).toEqual(["system:127.0.0.1", "system:localhost"]);
    expect((await call("nowhere.example")).err).toBeTruthy();
  });

  it("asks the phone's DNS servers before public ones, and is off outside Android", () => {
    expect(dnsServers({ LUMEN_DNS: "192.168.1.1, junk,8.8.8.8" })).toEqual([
      "192.168.1.1",
      "8.8.8.8",
      "1.1.1.1",
      "9.9.9.9",
    ]);
    expect(setupAndroid({})).toBe(false);
  });
});
