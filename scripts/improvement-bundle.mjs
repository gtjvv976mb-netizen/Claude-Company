import { buildImprovementBundle } from "../src/improvement-bundle.js";

process.stdout.write(`${JSON.stringify(buildImprovementBundle(), null, 2)}\n`);
