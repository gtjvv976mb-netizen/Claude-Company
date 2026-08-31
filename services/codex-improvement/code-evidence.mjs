import fs from "node:fs/promises";
import path from "node:path";

/** Ground every model-authored code citation in the trusted checkout before it can
 * enter an artifact. Symlinks, missing files, escapes, and invented line ranges fail
 * closed even though the proposal contract has already constrained their shape. */
export async function validateCodeEvidence(report, root) {
  const lexicalRoot = path.resolve(root);
  const realRoot = await fs.realpath(lexicalRoot);
  for (const proposal of report.proposals) {
    for (const evidence of proposal.evidence) {
      if (evidence.kind !== "code") continue;
      const file = path.resolve(lexicalRoot, evidence.path);
      if (file === lexicalRoot || !file.startsWith(`${lexicalRoot}${path.sep}`)) {
        throw new Error("unsafe code evidence path");
      }
      let stat, real;
      try {
        [stat, real] = await Promise.all([fs.lstat(file), fs.realpath(file)]);
      } catch {
        throw new Error(`missing code evidence file: ${evidence.path}`);
      }
      if (stat.isSymbolicLink() || !stat.isFile() ||
          (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`))) {
        throw new Error(`unsafe code evidence file: ${evidence.path}`);
      }
      const lines = (await fs.readFile(real, "utf8")).split("\n");
      if (evidence.lineStart < 1 || evidence.lineEnd < evidence.lineStart ||
          evidence.lineEnd > lines.length) {
        throw new Error(`code evidence range is outside ${evidence.path}`);
      }
    }
  }
}
