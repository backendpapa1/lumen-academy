// Builds what the desktop app ships beside its Rust shell (ADR-011):
//   build/server/server.mjs      the server, bundled (@lumen/shared inlined)
//   build/server/node_modules/   its production dependencies (native ones built for Node 24)
//   build/server/config/         models, pricing, game, art prompts
//   build/server/drizzle/        migrations
//   build/server/prompts/        agent prompts (*.md)
//   build/server/client/         the built game client, served by the server
//   src-tauri/binaries/lumen-node-<triple>   the Node runtime (a Tauri sidecar)
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");
const server = join(repo, "apps", "server");
const out = join(desktop, "build", "server");
const step = (s) => console.log(`\n▸ ${s}`);
const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

// --js: rebuild only the client and server.mjs (node_modules unchanged), for quick iterations.
const jsOnly = process.argv.includes("--js") && existsSync(join(out, "node_modules"));
if (!jsOnly) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

step("client: vite build");
run("pnpm", ["--filter", "@lumen/client", "build"]);
rmSync(join(out, "client"), { recursive: true, force: true });
cpSync(join(repo, "apps", "client", "dist"), join(out, "client"), { recursive: true });

step("server: esbuild bundle");
const pkg = JSON.parse(readFileSync(join(server, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => d !== "@lumen/shared");
await build({
  entryPoints: [join(server, "src", "index.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Every real dependency stays in node_modules; only our own workspace code is inlined.
  external: [...external, ...external.map((d) => `${d}/*`)],
  sourcemap: "linked",
  logLevel: "warning",
  banner: {
    // Bundled ESM still meets a require() or two inside dependencies.
    js: "import { createRequire as __lumenRequire } from 'node:module'; const require = __lumenRequire(import.meta.url);",
  },
});

if (jsOnly) {
  for (const profile of ["debug", "release"]) {
    const t = join(desktop, "src-tauri", "target", profile, "server");
    if (existsSync(t)) {
      cpSync(join(out, "server.mjs"), join(t, "server.mjs"));
      rmSync(join(t, "client"), { recursive: true, force: true });
      cpSync(join(out, "client"), join(t, "client"), { recursive: true });
    }
  }
  console.log(`\n✓ client and server.mjs rebuilt in ${out}`);
  process.exit(0);
}

step("server: production node_modules (pnpm deploy)");
const deploy = join(desktop, "build", "deploy");
rmSync(deploy, { recursive: true, force: true });
// Hoisted: a flat node_modules with real files, no symlinks, which bundles cleanly.
run("pnpm", [
  "--filter",
  "@lumen/server",
  "deploy",
  "--prod",
  "--legacy",
  "--config.node-linker=hoisted",
  deploy,
]);
cpSync(join(deploy, "node_modules"), join(out, "node_modules"), { recursive: true });
// deploy --prod leaves the workspace marked as a production install; put it back.
run("pnpm", ["install", "--frozen-lockfile"]);
rmSync(deploy, { recursive: true, force: true });
// Prebuilt binaries for other platforms are dead weight in a Linux build.
prune(join(out, "node_modules"));

step("config, migrations, prompts");
cpSync(join(repo, "config"), join(out, "config"), { recursive: true });
cpSync(join(server, "drizzle"), join(out, "drizzle"), { recursive: true });
mkdirSync(join(out, "prompts"));
for (const f of readdirSync(join(server, "src", "agents", "prompts")))
  if (f.endsWith(".md"))
    cpSync(join(server, "src", "agents", "prompts", f), join(out, "prompts", f));

step("node runtime (sidecar)");
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const bin = join(desktop, "src-tauri", "binaries");
mkdirSync(bin, { recursive: true });
cpSync(process.execPath, join(bin, `lumen-node-${triple}`));
console.log(`  Node ${process.version} → binaries/lumen-node-${triple}`);

// Tauri copies resources into target/<profile>/server without clearing old
// files; clear them so a package never carries leftovers.
for (const profile of ["debug", "release"])
  rmSync(join(desktop, "src-tauri", "target", profile, "server"), { recursive: true, force: true });
rmSync(join(desktop, "src-tauri", "target", "release", "bundle"), { recursive: true, force: true });

console.log(`\n✓ server bundle in ${out} (${mb(out)} MB)`);

function prune(nm) {
  const drop = (p) => existsSync(p) && rmSync(p, { recursive: true, force: true });
  // better-sqlite3's C sources and object files; the built .node stays.
  for (const d of [
    "deps",
    "src",
    "build/Release/obj",
    "build/Release/obj.target",
    "build/Release/.deps",
  ])
    drop(join(nm, "better-sqlite3", d));
  // better-sqlite3 ships a prebuilt binding per platform; it loads linux-x64 here.
  // (A musl one also breaks the AppImage step, which can't resolve musl's libc.)
  const pre = join(nm, "better-sqlite3", "prebuilds");
  if (existsSync(pre))
    for (const f of readdirSync(pre)) if (f !== "linux-x64.node") drop(join(pre, f));
  // onnxruntime-node ships every OS; keep linux/x64.
  const bins = join(nm, "onnxruntime-node", "bin");
  if (existsSync(bins))
    for (const napi of readdirSync(bins)) {
      for (const os of readdirSync(join(bins, napi)))
        if (os !== "linux") drop(join(bins, napi, os));
      const linux = join(bins, napi, "linux");
      if (existsSync(linux))
        for (const arch of readdirSync(linux)) if (arch !== "x64") drop(join(linux, arch));
    }
  // Source maps and .bin links are for developing these packages, not running them.
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name === ".bin") drop(p);
      else if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".map")) rmSync(p);
    }
  };
  walk(nm);
}

function mb(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += statSync(p).size;
    }
  };
  walk(dir);
  return Math.round(n / 1e6);
}
