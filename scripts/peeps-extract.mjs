// Extracts the Open Peeps parts we use into plain SVG strings with colour
// placeholders, so the client can draw students without React (ADR-009).
//
// Open Peeps artwork: Pablo Stanley, CC0. Component package: @opeepsfun/open-peeps (MIT).
// Not a runtime dependency. To regenerate, in a scratch directory:
//   npm i react@18 react-dom@18 @opeepsfun/open-peeps@1.0.6
//   node <repo>/scripts/peeps-extract.mjs <scratch>/node_modules <repo>/apps/client/src/ui/peeps/parts.generated.ts

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [modules, out] = process.argv.slice(2);
if (!modules || !out) throw new Error("usage: peeps-extract.mjs <node_modules> <out.ts>");
const require = createRequire(join(modules, "x.js"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const build = join(modules, "@opeepsfun/open-peeps/build");
// Effigy.js calls require() from ESM; give it one.
globalThis.require = createRequire(join(build, "Effigy.js"));
const { Effigy } = require(join(build, "Effigy.js"));

// Placeholders the client swaps for real colours. Every colour prop of every part maps to one.
const TOKENS = {
  outlineColor: "#0000a1",
  skinColor: "#0000a2",
  hairColor: "#0000a3",
  topColor: "#0000a4",
  jacketColor: "#0000a5",
  blazerColor: "#0000a5",
  paperColor: "#0000a6",
  cupColor: "#0000a7",
  computerColor: "#0000a8",
  beanieColor: "#0000a9",
  capColor: "#0000a9",
  hijabColor: "#0000a9",
  turbanColor: "#0000a9",
  clipColor: "#0000a9",
  frameColor: "#0000a1",
  beardColor: "#0000a3",
  pocketColor: "#0000a5",
};

// Curated: everyday clothes and the poses the classroom needs, plus most hairstyles.
const BODIES = [
  "ButtonShirt",
  "ButtonPocketShirt",
  "Hoodie",
  "Jacket",
  "PoloSweater",
  "SportyTee",
  "StripedTee",
  "Tee",
  "TeeSelena",
  "Turtleneck",
  "SweaterDots",
  "Dress",
  "ShirtCoat",
  "BlazerBlackTee",
  // poses
  "PointingUp",
  "Explaining",
  "Paper",
  "TeeArmsCrossed",
  "Coffee",
  "Computer",
];
const HEADS = [
  "Afro",
  "Bald",
  "Bangs",
  "BangsTwo",
  "BantuKnots",
  "Beanie",
  "Bun",
  "BunClip",
  "BunKnots",
  "BunTwo",
  "ColorBun",
  "ColorMedium",
  "Cornrows",
  "CornrowsLight",
  "DreadsOne",
  "DreadsTwo",
  "FlatTop",
  "FlatTopLong",
  "GrayShort",
  "Hijab",
  "LongAfro",
  "LongBangs",
  "LongCurly",
  "LongHair",
  "MediumBangs",
  "MediumBangsColor",
  "MediumBangsOne",
  "MediumOne",
  "MediumStraight",
  "MediumThree",
  "MediumTwo",
  "Mohawk",
  "NoHairThree",
  "NoHairTwo",
  "Pomp",
  "Shaved",
  "ShavedOne",
  "ShavedThree",
  "ShortFive",
  "ShortFour",
  "ShortOne",
  "ShortThree",
  "ShortTwo",
  "Turban",
  "Twists",
  "TwistsTwo",
  "Wavy",
];
const FACES = [
  "Calm",
  "Smile",
  "BigSmile",
  "SmileTeeth",
  "Cute",
  "Cheeky",
  "Concerned",
  "Awe",
  "Tired",
  "Suspicious",
  "Driven",
  "Explaining",
  "Serious",
  "Solemn",
  "Hectic",
  "EyesClosed",
  "Blank",
  "Fear",
];
const BEARDS = [
  "Chin",
  "Full",
  "FullMedium",
  "Goatee",
  "GoateeFull",
  "MustacheThin",
  "MustacheSix",
];
const ACCESSORIES = ["Glasses", "GlassesTwo", "GlassesThree", "GlassesFour", "GlassesFive"];

const props = Object.fromEntries(Object.keys(TOKENS).map((k) => [k, TOKENS[k]]));
const opt = { options: props };
const render = (cfg) => renderToStaticMarkup(React.createElement(Effigy, { ...cfg }));

/** Inner markup of the first <g id="…"> (balanced), and its own transform. */
function group(svg, id) {
  const open = svg.indexOf(`<g id="${id}"`);
  if (open < 0) return null;
  const startTagEnd = svg.indexOf(">", open) + 1;
  let depth = 1;
  let i = startTagEnd;
  while (depth > 0) {
    const nextOpen = svg.indexOf("<g", i);
    const nextClose = svg.indexOf("</g>", i);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // self-closing <g/> doesn't nest
      const end = svg.indexOf(">", nextOpen);
      if (svg[end - 1] !== "/") depth++;
      i = end + 1;
    } else {
      depth--;
      i = nextClose + 4;
    }
  }
  const tag = svg.slice(open, startTagEnd);
  const transform = /transform="([^"]*)"/.exec(tag)?.[1] ?? "";
  return { inner: svg.slice(startTagEnd, i - 4), transform };
}

/** The transform Effigy puts around the head group for a body (it lifts the head for some poses). */
function headWrap(svg) {
  const at = svg.indexOf('<g id="Head"');
  const before = svg.slice(0, at);
  const m = /<g transform="([^"]*)">$/.exec(before);
  return m ? m[1] : "";
}

const base = {
  body: { type: "Tee", options: props },
  head: { type: "ShortOne", ...opt },
  face: { type: "Calm", ...opt },
};
const viewBox = /viewBox="([^"]*)"/.exec(render(base))[1];

const parts = {
  viewBox,
  groups: {},
  bodies: {},
  heads: {},
  faces: {},
  beards: {},
  accessories: {},
};
{
  const svg = render({
    ...base,
    beard: { type: "Chin", ...opt },
    accessory: { type: "Glasses", ...opt },
  });
  for (const id of ["Body", "Hair", "Face", "Beard", "Accessories"])
    parts.groups[id] = group(svg, id).transform;
}
for (const b of BODIES) {
  const svg = render({ ...base, body: { type: b, options: props } });
  parts.bodies[b] = { svg: group(svg, "Body").inner, head: headWrap(svg) };
}
for (const h of HEADS)
  parts.heads[h] = group(render({ ...base, head: { type: h, ...opt } }), "Hair").inner;
for (const f of FACES)
  parts.faces[f] = group(render({ ...base, face: { type: f, ...opt } }), "Face").inner;
for (const b of BEARDS)
  parts.beards[b] = group(render({ ...base, beard: { type: b, ...opt } }), "Beard").inner;
for (const a of ACCESSORIES)
  parts.accessories[a] = group(
    render({ ...base, accessory: { type: a, ...opt } }),
    "Accessories",
  ).inner;

// Shorter placeholders in the output: §1…§9.
const short = Object.fromEntries(
  [...new Set(Object.values(TOKENS))].map((hex) => [
    hex,
    `§${hex.slice(-1) === "1" ? 1 : Number.parseInt(hex.slice(-2), 16) - 0xa0}`,
  ]),
);
const json = JSON.stringify(parts).replace(/#0000a[0-9a-f]/gi, (m) => short[m.toLowerCase()] ?? m);

writeFileSync(
  out,
  `// Generated by scripts/peeps-extract.mjs. Do not edit.
// Open Peeps by Pablo Stanley (CC0), via @opeepsfun/open-peeps (MIT).
// Colour slots: §1 outline · §2 skin · §3 hair · §4 top · §5 jacket · §6 paper · §7 cup · §8 computer · §9 headwear.
export const PEEPS = ${json} as const;
`,
);
console.log(`wrote ${out}: ${(json.length / 1024).toFixed(0)} KB`);
