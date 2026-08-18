import { runGpuCheck } from "./diagnostics/gpu.js";

function printGpuVerdict(verdict: Awaited<ReturnType<typeof runGpuCheck>>): void {
  const { report, missing, accelerated } = verdict;

  console.log("Browser:  ", report.chromeVersion ?? "unknown");
  console.log("System:   ", report.operatingSystem ?? "unknown");
  console.log("Renderer: ", report.webglRenderer ?? "unknown");
  console.log("");
  console.log("Graphics feature status");
  for (const feature of report.features) {
    const mark = feature.hardwareAccelerated ? "[hw]" : "[  ]";
    console.log(`  ${mark} ${feature.name}: ${feature.status}`);
  }
  console.log("");

  if (accelerated) {
    console.log("OK: compositing and rasterization run on the GPU.");
    return;
  }
  console.log(`FAILED: ${missing.join(", ")}`);
  console.log("Measurements taken in this browser are not comparable.");
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);

  if (command !== "check-gpu") {
    console.log("Usage: animbench check-gpu");
    process.exitCode = 1;
    return;
  }

  const verdict = await runGpuCheck();
  printGpuVerdict(verdict);
  if (!verdict.accelerated) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
