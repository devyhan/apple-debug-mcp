/**
 * M2 offline eval CLI: dataset + ExactMatchBaseline + harness -> JSON report.
 *
 * Fully offline: reads local fixture files only, prints the report to stdout.
 * Usage: node dist/eval-cli.js [--dataset data/eval/v1] [--tau 0.5]
 */
import { ExactMatchBaseline } from "./eval-baseline.js";
import { EvalDataset } from "./eval-dataset.js";
import { EvalHarness } from "./eval-harness.js";

function takeValue(args: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  }
  return undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: node dist/eval-cli.js [--dataset data/eval/v1] [--tau 0.5]\n");
    return;
  }
  const datasetDir = takeValue(argv, ["--dataset"]) ?? "data/eval/v1";
  const tauRaw = takeValue(argv, ["--tau"]);
  const tau = tauRaw === undefined ? 0.5 : Number(tauRaw);
  if (!Number.isFinite(tau) || tau < 0 || tau > 1) {
    console.error(`invalid --tau ${JSON.stringify(tauRaw)} (want 0..1)`);
    process.exitCode = 1;
    return;
  }
  const dataset = EvalDataset.loadDir(datasetDir);
  const baseline = new ExactMatchBaseline();
  const report = new EvalHarness().run(dataset.cases, (s) => baseline.predict(s), { tau });
  console.log(JSON.stringify(report, null, 2));
}

main();
