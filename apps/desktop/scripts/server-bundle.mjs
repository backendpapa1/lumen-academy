// The steps that build Lumen's server bundle, shared by the desktop
// (bundle-server.mjs, ADR-011) and Android (bundle-android.mjs, ADR-012):
//   <out>/server.mjs      the server, bundled (@lumen/shared inlined)
//   <out>/node_modules/   its production dependencies
//   <out>/config/         models, pricing, game, art prompts
//   <out>/drizzle/        migrations
//   <out>/prompts/        agent prompts (*.md)
//   <out>/client/         the built game client, served by the server
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
export const desktop = join(here, "..");
export const repo = join(desktop, "..", "..");
export const server = join(repo, "apps", "server");
export const step = (s) => console.log(`\n▸ ${s}`);
export const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

export function buildClient(out) {
  step("client: vite build");
  run("pnpm", ["--filter", "@lumen/client", "build"]);
  rmSync(join(out, "client"), { recursive: true, force: true });
  cpSync(join(repo, "apps", "client", "dist"), join(out, "client"), { recursive: true });
}

export async function bundleServer(out) {
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
}

/** Production node_modules from `pnpm deploy`, flat (hoisted) with real files. */
export function deployModules(out, scratch) {
  step("server: production node_modules (pnpm deploy)");
  rmSync(scratch, { recursive: true, force: true });
  run("pnpm", [
    "--filter",
    "@lumen/server",
    "deploy",
    "--prod",
    "--legacy",
    "--config.node-linker=hoisted",
    scratch,
  ]);
  cpSync(join(scratch, "node_modules"), join(out, "node_modules"), { recursive: true });
  // deploy --prod leaves the workspace marked as a production install; put it back.
  run("pnpm", ["install", "--frozen-lockfile"]);
  rmSync(scratch, { recursive: true, force: true });
}

export function copyConfig(out) {
  step("config, migrations, prompts");
  cpSync(join(repo, "config"), join(out, "config"), { recursive: true });
  cpSync(join(server, "drizzle"), join(out, "drizzle"), { recursive: true });
  mkdirSync(join(out, "prompts"), { recursive: true });
  for (const f of readdirSync(join(server, "src", "agents", "prompts")))
    if (f.endsWith(".md"))
      cpSync(join(server, "src", "agents", "prompts", f), join(out, "prompts", f));
}

const drop = (p) => existsSync(p) && rmSync(p, { recursive: true, force: true });

/**
 * Drops what the target platform never loads. `arch` is "x64" or "arm64"; on
 * Linux better-sqlite3 and onnxruntime-node keep only that arch's binary.
 */
export function prune(nm, arch) {
  // better-sqlite3's C sources and object files; the built .node stays.
  for (const d of [
    "deps",
    "src",
    "build/Release/obj",
    "build/Release/obj.target",
    "build/Release/.deps",
  ])
    drop(join(nm, "better-sqlite3", d));
  // better-sqlite3 ships a prebuilt binding per platform; keep linux-<arch>.
  // (A musl one also breaks the AppImage step, which can't resolve musl's libc.)
  const pre = join(nm, "better-sqlite3", "prebuilds");
  if (existsSync(pre))
    for (const f of readdirSync(pre)) if (f !== `linux-${arch}.node`) drop(join(pre, f));
  // onnxruntime-node ships every OS; keep linux/<arch>.
  const bins = join(nm, "onnxruntime-node", "bin");
  if (existsSync(bins))
    for (const napi of readdirSync(bins)) {
      for (const os of readdirSync(join(bins, napi)))
        if (os !== "linux") drop(join(bins, napi, os));
      const linux = join(bins, napi, "linux");
      if (existsSync(linux))
        for (const a of readdirSync(linux)) if (a !== arch) drop(join(linux, a));
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

export function mb(dir) {
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
