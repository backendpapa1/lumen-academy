// Builds what the desktop app ships beside its Rust shell (ADR-011):
//   build/server/            the bundled server, its node_modules, config, migrations,
//                            prompts and the built client (server-bundle.mjs)
//   src-tauri/binaries/lumen-node-<triple>   the Node runtime (a Tauri sidecar)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildClient,
  bundleServer,
  copyConfig,
  deployModules,
  desktop,
  mb,
  prune,
  step,
} from "./server-bundle.mjs";

const out = join(desktop, "build", "server");

// --js: rebuild only the client and server.mjs (node_modules unchanged), for quick iterations.
const jsOnly = process.argv.includes("--js") && existsSync(join(out, "node_modules"));
if (!jsOnly) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

buildClient(out);
await bundleServer(out);

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

deployModules(out, join(desktop, "build", "deploy"));
// Prebuilt binaries for other platforms are dead weight in a Linux build.
prune(join(out, "node_modules"), "x64");
copyConfig(out);

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
