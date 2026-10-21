// Builds what the Android app ships (ADR-012), beside the Tauri/Gradle build:
//
//   gen/android/app/src/main/jniLibs/arm64-v8a/
//     libld.so       Debian's glibc loader (ld-linux-aarch64.so.1). Android only lets
//                    an app exec files from its native library dir, so this is the one
//                    program we launch; it maps Node and everything else from files/.
//     libsigsys.so   the seccomp supervisor (android/sigsys.c, built with the NDK)
//   gen/android/app/src/main/assets/
//     lumen-runtime-<n>.tar.xz  rt/ (Node linux-arm64 + glibc) and server/ (the bundle
//                               with arm64 natives), in parts unpacked in parallel on
//                               first run
//     lumen-runtime.json        the parts and their stamp: a new stamp makes the app
//                               unpack again
//
// Downloads are checked: Node against nodejs.org's SHASUMS256.txt; the Debian
// packages against the Packages index, whose own hash comes from InRelease; npm
// packages by npm's integrity check. They're cached in build/android-cache/.
//
//   node scripts/bundle-android.mjs          everything
//   node scripts/bundle-android.mjs --js     rebuild the client and server.mjs only
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildClient,
  bundleServer,
  copyConfig,
  deployModules,
  desktop,
  mb,
  prune,
  server,
  step,
} from "./server-bundle.mjs";

const NODE_VERSION = process.version; // the same Node the desktop ships (ABI of the natives)
const DEBIAN = "https://deb.debian.org/debian";
const SUITE = "bookworm"; // glibc 2.36
const DEBS = ["libc6", "libgcc-s1", "libstdc++6"];
// The glibc libraries Node and the natives load (ldd on node, better-sqlite3, sharp, sqlite-vec).
const LIBS = [
  "ld-linux-aarch64.so.1",
  "libc.so.6",
  "libm.so.6",
  "libdl.so.2",
  "libpthread.so.0",
  "librt.so.1",
  "libresolv.so.2",
  "libgcc_s.so.1",
  "libstdc++.so.6",
];
// Android speaks and listens natively: Kokoro (and the ONNX Runtime under it,
// which needs ARMv8.2+) stays out of the APK.
const SPEECH_ONLY = ["@huggingface/transformers", "kokoro-js"];
// The runtime archive's parts, unpacked in parallel on the phone.
const PARTS = 4;

const build = join(desktop, "build", "android");
const cache = join(desktop, "build", "android-cache");
const outServer = join(build, "server");
const outRt = join(build, "rt");
const app = join(desktop, "src-tauri", "gen", "android", "app", "src", "main");
const jni = join(app, "jniLibs", "arm64-v8a");
const assets = join(app, "assets");
mkdirSync(cache, { recursive: true });

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
async function download(url, to) {
  if (existsSync(to)) return to;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const tmp = `${to}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  execFileSync("mv", [tmp, to]);
  return to;
}
function expectHash(file, want, what) {
  const got = sha256(file);
  if (got !== want) {
    rmSync(file, { force: true });
    throw new Error(`${what}: sha256 ${got}, expected ${want}`);
  }
}

const jsOnly = process.argv.includes("--js") && existsSync(join(outServer, "node_modules"));

// --- the server -----------------------------------------------------------------
if (!jsOnly) rmSync(outServer, { recursive: true, force: true });
mkdirSync(outServer, { recursive: true });
buildClient(outServer);
await bundleServer(outServer);
// The bundle's source map is for debugging on a desktop; it's 10+ MB on the phone.
rmSync(join(outServer, "server.mjs.map"), { force: true });
if (!jsOnly) {
  deployModules(outServer, join(desktop, "build", "deploy-android"));
  const nm = join(outServer, "node_modules");
  dropUnreachable(nm);
  prune(nm, "arm64");
  await armNatives(nm);
  copyConfig(outServer);
  checkNoForeignBinaries(outServer);
}

// --- the runtime: Node and glibc ------------------------------------------------
if (!existsSync(join(outRt, "bin", "node"))) {
  rmSync(outRt, { recursive: true, force: true });
  mkdirSync(join(outRt, "bin"), { recursive: true });
  mkdirSync(join(outRt, "lib"), { recursive: true });
  await fetchNode();
  await fetchGlibc();
}

// --- native libs and the archive -----------------------------------------------
step("jniLibs: the loader and the supervisor");
mkdirSync(jni, { recursive: true });
copyFileSync(join(outRt, "lib", "ld-linux-aarch64.so.1"), join(jni, "libld.so"));
buildSigsys(join(jni, "libsigsys.so"));

step(`assets: lumen-runtime-*.tar.xz (${PARTS} parts)`);
mkdirSync(assets, { recursive: true });
for (const f of readdirSync(assets)) if (f.startsWith("lumen-runtime")) rmSync(join(assets, f));
// xz decodes at a few MB/s on a phone's core, so the runtime ships in parts of
// about equal size that the app unpacks in parallel (LumenRuntime.kt).
const files = [];
const list = (dir) => {
  for (const e of readdirSync(join(build, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) list(rel);
    else files.push({ rel, size: statSync(join(build, rel)).size });
  }
};
list("rt");
list("server");
const buckets = Array.from({ length: PARTS }, () => ({ size: 0, files: [] }));
for (const f of files.sort((x, y) => y.size - x.size || x.rel.localeCompare(y.rel))) {
  const b = buckets.reduce((m, c) => (c.size < m.size ? c : m));
  b.size += f.size;
  b.files.push(f.rel);
}
const parts = [];
const hash = createHash("sha256");
for (const [i, b] of buckets.entries()) {
  const name = `lumen-runtime-${i}.tar.xz`;
  const listFile = join(build, `.part-${i}.txt`);
  writeFileSync(listFile, b.files.sort().join("\n") + "\n");
  // Reproducible: sorted, no owners, fixed times. xz at preset 9 with a 16 MiB
  // dictionary: each decoder on the phone holds its dictionary, and four 64 MiB
  // ones (plain -9) overflow the app's Java heap.
  execFileSync(
    "sh",
    [
      "-c",
      `tar --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -T "${listFile}" | xz --lzma2=preset=9e,dict=16MiB -T0 > "${join(assets, name)}"`,
    ],
    { cwd: build, stdio: ["ignore", "ignore", "inherit"] },
  );
  rmSync(listFile);
  hash.update(readFileSync(join(assets, name)));
  parts.push({ name, bytes: statSync(join(assets, name)).size });
}
const stamp = hash.digest("hex").slice(0, 16);
const unpacked = mb(outRt) + mb(outServer);
writeFileSync(
  join(assets, "lumen-runtime.json"),
  JSON.stringify({ stamp, node: NODE_VERSION, unpackedMb: unpacked, parts }, null, 2) + "\n",
);
const total = parts.reduce((n, p) => n + p.bytes, 0);
console.log(
  `\n✓ lumen-runtime: ${PARTS} parts, ${Math.round(total / 1e6)} MB (unpacks to ${unpacked} MB), stamp ${stamp}`,
);

// --- helpers --------------------------------------------------------------------

/** Deletes every package the server can't reach once the speech-only ones are gone. */
function dropUnreachable(nm) {
  step("server: drop Kokoro and what only it needs");
  const pkg = JSON.parse(readFileSync(join(server, "package.json"), "utf8"));
  const roots = Object.keys(pkg.dependencies).filter(
    (d) => d !== "@lumen/shared" && !SPEECH_ONLY.includes(d),
  );
  const keep = new Set();
  // Node's resolution: <from>/node_modules/<name>, then each parent's node_modules.
  const resolve = (from, name) => {
    for (let d = from; d.startsWith(nm); d = dirname(d)) {
      const p = join(d, "node_modules", name);
      if (existsSync(join(p, "package.json"))) return p;
      if (d === dirname(d)) break;
    }
    const top = join(nm, name);
    return existsSync(join(top, "package.json")) ? top : null;
  };
  const visit = (dir) => {
    if (keep.has(dir)) return;
    keep.add(dir);
    const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const d of Object.keys({
      ...p.dependencies,
      ...p.optionalDependencies,
      ...p.peerDependencies,
    })) {
      const hit = resolve(dir, d);
      if (hit) visit(hit);
    }
  };
  for (const r of roots) {
    const hit = resolve(nm, r);
    if (!hit) throw new Error(`${r} is missing from the deployed node_modules`);
    visit(hit);
  }
  let dropped = 0;
  const sweep = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".bin") continue;
      const p = join(dir, e.name);
      if (e.name.startsWith("@")) {
        sweep(p);
        if (!readdirSync(p).length) rmSync(p, { recursive: true });
        continue;
      }
      if (!existsSync(join(p, "package.json"))) continue;
      if (!keep.has(p)) {
        rmSync(p, { recursive: true, force: true });
        dropped++;
      } else if (existsSync(join(p, "node_modules"))) sweep(join(p, "node_modules"));
    }
  };
  sweep(nm);
  console.log(`  kept ${keep.size} packages, dropped ${dropped}`);
}

/** Swaps the x64 prebuilt natives for linux-arm64 ones (better-sqlite3 ships both). */
async function armNatives(nm) {
  step("server: linux-arm64 natives");
  const version = (p) => JSON.parse(readFileSync(join(nm, p, "package.json"), "utf8")).version;
  const sharp = JSON.parse(readFileSync(join(nm, "sharp", "package.json"), "utf8"));
  const want = {
    "sqlite-vec-linux-arm64": version("sqlite-vec"),
    "@img/sharp-linux-arm64": sharp.optionalDependencies["@img/sharp-linux-arm64"],
    "@img/sharp-libvips-linux-arm64": sharp.optionalDependencies["@img/sharp-libvips-linux-arm64"],
  };
  for (const [name, v] of Object.entries(want)) {
    const dir = join(cache, "npm");
    mkdirSync(dir, { recursive: true });
    const tgz = join(dir, `${name.replace("@", "").replace("/", "-")}-${v}.tgz`);
    if (!existsSync(tgz)) {
      // npm checks the tarball against the registry's integrity hash.
      const got = execFileSync("npm", ["pack", `${name}@${v}`, "--pack-destination", dir], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .at(-1);
      if (join(dir, got) !== tgz) execFileSync("mv", [join(dir, got), tgz]);
    }
    const to = join(nm, name);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    execFileSync("tar", ["-xzf", tgz, "-C", to, "--strip-components=1"]);
    console.log(`  ${name}@${v}`);
  }
  for (const x of ["sqlite-vec-linux-x64", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"])
    rmSync(join(nm, x), { recursive: true, force: true });
  if (!existsSync(join(nm, "better-sqlite3", "prebuilds", "linux-arm64.node")))
    throw new Error("better-sqlite3 has no linux-arm64 prebuild");
}

/** Fails if any ELF file in the bundle isn't for arm64 (a native we forgot to swap). */
function checkNoForeignBinaries(dir) {
  const bad = [];
  const head = Buffer.alloc(20);
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(node|so(\.\d+)*)$/.test(e.name)) {
        const fd = openSync(p, "r");
        readSync(fd, head, 0, 20, 0);
        closeSync(fd);
        // ELF, e_machine at 18: 0xB7 is AArch64.
        if (head.readUInt32BE(0) === 0x7f454c46 && head.readUInt16LE(18) !== 0xb7) bad.push(p);
      }
    }
  };
  walk(dir);
  if (bad.length) throw new Error(`not arm64:\n  ${bad.join("\n  ")}`);
}

async function fetchNode() {
  step(`runtime: Node ${NODE_VERSION} linux-arm64`);
  const name = `node-${NODE_VERSION}-linux-arm64`;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums
    .split("\n")
    .find((l) => l.endsWith(`  ${name}.tar.xz`))
    ?.split(/\s+/)[0];
  if (!want) throw new Error(`${name}.tar.xz isn't in SHASUMS256.txt`);
  const tar = await download(`${base}/${name}.tar.xz`, join(cache, `${name}.tar.xz`));
  expectHash(tar, want, `${name}.tar.xz`);
  const tmp = join(cache, "node-x");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  execFileSync("tar", ["-xJf", tar, "-C", tmp, `${name}/bin/node`, `${name}/LICENSE`]);
  copyFileSync(join(tmp, name, "bin", "node"), join(outRt, "bin", "node"));
  copyFileSync(join(tmp, name, "LICENSE"), join(outRt, "NODE-LICENSE"));
  chmodSync(join(outRt, "bin", "node"), 0o755);
  rmSync(tmp, { recursive: true, force: true });
}

async function fetchGlibc() {
  step(`runtime: Debian ${SUITE} glibc (arm64)`);
  const inRelease = await (await fetch(`${DEBIAN}/dists/${SUITE}/InRelease`)).text();
  const sha = inRelease.split("SHA256:")[1] ?? "";
  const line = sha.split("\n").find((l) => l.trim().endsWith(" main/binary-arm64/Packages.xz"));
  if (!line) throw new Error("InRelease lists no main/binary-arm64/Packages.xz");
  const packagesXz = join(cache, `${SUITE}-arm64-Packages.xz`);
  rmSync(packagesXz, { force: true }); // always the current index
  await download(`${DEBIAN}/dists/${SUITE}/main/binary-arm64/Packages.xz`, packagesXz);
  expectHash(packagesXz, line.trim().split(/\s+/)[0], "Packages.xz");
  const packages = execFileSync("xz", ["-dc", packagesXz], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const x = join(cache, "glibc-x");
  rmSync(x, { recursive: true, force: true });
  mkdirSync(x);
  const versions = {};
  for (const name of DEBS) {
    const stanza = packages.split("\n\n").find((s) => s.startsWith(`Package: ${name}\n`));
    if (!stanza) throw new Error(`${name} isn't in the ${SUITE} index`);
    const field = (f) => stanza.match(new RegExp(`^${f}: (.+)$`, "m"))?.[1];
    const file = field("Filename");
    const deb = await download(`${DEBIAN}/${file}`, join(cache, file.split("/").at(-1)));
    expectHash(deb, field("SHA256"), file);
    execFileSync("dpkg-deb", ["-x", deb, x]);
    versions[name] = field("Version");
  }
  for (const lib of LIBS) {
    const hit = ["lib/aarch64-linux-gnu", "usr/lib/aarch64-linux-gnu"]
      .map((d) => join(x, d, lib))
      .find((p) => existsSync(p));
    if (!hit) throw new Error(`${lib} isn't in the Debian packages`);
    copyFileSync(hit, join(outRt, "lib", lib)); // follows the .so symlinks
  }
  writeFileSync(
    join(outRt, "VERSIONS.json"),
    JSON.stringify({ node: NODE_VERSION, ...versions }, null, 2),
  );
  console.log(
    `  ${Object.entries(versions)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  rmSync(x, { recursive: true, force: true });
}

function ndkClang() {
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
  const ndk =
    process.env.NDK_HOME ??
    join(
      sdk,
      "ndk",
      readdirSync(join(sdk, "ndk"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .at(-1),
    );
  const clang = join(
    ndk,
    "toolchains",
    "llvm",
    "prebuilt",
    "linux-x86_64",
    "bin",
    "aarch64-linux-android29-clang",
  );
  if (!existsSync(clang)) throw new Error(`no NDK clang at ${clang} (set NDK_HOME)`);
  return clang;
}

function buildSigsys(to) {
  execFileSync(
    ndkClang(),
    ["-O2", "-fPIE", "-pie", "-Wall", "-o", to, join(desktop, "android", "sigsys.c")],
    {
      stdio: "inherit",
    },
  );
}
