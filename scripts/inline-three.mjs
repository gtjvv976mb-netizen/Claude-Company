// three.module.js imports from ./three.core.js, so a self-contained artifact needs the two
// concatenated with that seam removed. Unminified builds are used deliberately: their
// identifiers match across the seam, which the minified ones do not.
//
// The THREE namespace is rebuilt from three's OWN export lists rather than a hand-written
// enumeration, so it can never drift out of date as the app uses more of the library.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const B = path.resolve(here, "..", "node_modules", "three", "build");

/** "A, B as C" -> [["A","A"], ["B","C"]] */
function parseExportList(body) {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\S+)\s+as\s+(\S+)$/);
      return m ? [m[1], m[2]] : [s, s];
    });
}

export function inlineThree() {
  let core = fs.readFileSync(path.join(B, "three.core.js"), "utf8");
  let mod = fs.readFileSync(path.join(B, "three.module.js"), "utf8");
  const names = new Map();      // exportedName -> localName (for the THREE namespace)
  const coreExports = [];       // [localName, exportedName] pairs crossing the core seam

  // --- core: capture then strip its single trailing export block ---
  const coreExp = core.match(/\nexport\s*\{([\s\S]*?)\};?\s*$/);
  if (!coreExp) throw new Error("three.core.js: trailing export block not found");
  for (const [local, exported] of parseExportList(coreExp[1])) {
    names.set(exported, local);
    coreExports.push([local, exported]);
  }
  core = core.slice(0, coreExp.index);

  // --- module: strip the import from core; capture+strip the re-export from core ---
  const impRe = /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/three\.core\.js['"];?\s*$/m;
  if (!impRe.test(mod)) throw new Error("three.module.js: import-from-core not found");
  mod = mod.replace(impRe, "");

  const reExp = mod.match(/^export\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/three\.core\.js['"];?\s*$/m);
  if (reExp) {
    for (const [local, exported] of parseExportList(reExp[1])) {
      names.set(exported, local);
      if (!coreExports.some(([, e]) => e === exported)) coreExports.push([local, exported]);
    }
    mod = mod.replace(reExp[0], "");
  }

  // --- module: capture then strip its own trailing export block ---
  const modExp = mod.match(/\nexport\s*\{([\s\S]*?)\};?\s*$/);
  if (!modExp) throw new Error("three.module.js: trailing export block not found");
  for (const [local, exported] of parseExportList(modExp[1])) names.set(exported, local);
  mod = mod.slice(0, modExp.index);

  // core and three.module both declare rollup-internal names like `_m1$1`. Concatenating
  // them into one scope is a duplicate-declaration SyntaxError, so core gets its own
  // function scope and hands only its exports across the seam.
  const coreOut = coreExports
    .map(([local, exported]) => (exported === local ? exported : `${exported}: ${local}`))
    .join(", ");
  const coreIn = coreExports.map(([, exported]) => exported).join(", ");

  const ns = [...names.keys()].join(", ");

  return {
    source:
      `const __THREE_CORE__ = (function () {\n${core}\nreturn { ${coreOut} };\n})();\n` +
      `const { ${coreIn} } = __THREE_CORE__;\n` +
      `${mod}\n` +
      `const THREE = { ${ns} };\n`,
    exportCount: names.size,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { source, exportCount } = inlineThree();
  console.log("bytes:", source.length, "| namespace entries:", exportCount);
  console.log("residual import/export statements:", (source.match(/^\s*(import|export)\s/gm) || []).length);
  fs.writeFileSync("/tmp/three-inline-test.mjs", source + "\nexport { THREE };\n");
}
