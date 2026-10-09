import { spawn, type ChildProcess } from "node:child_process";

export interface KeepAwake {
  /** Tool holding the machine awake, or null when nothing could be started. */
  method: string | null;
  release(): void;
}

/**
 * Sets ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED and holds it
 * for as long as the PowerShell process lives.
 */
const WINDOWS_SCRIPT = [
  `$s = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
  "$k = Add-Type -MemberDefinition $s -Name Power -Namespace Animbench -PassThru",
  "while ($true) { $k::SetThreadExecutionState(0x80000003) | Out-Null; Start-Sleep -Seconds 30 }",
].join("; ");

function command(): { method: string; file: string; args: string[] } | null {
  switch (process.platform) {
    case "darwin":
      // -d display, -i idle, -s system on mains, -m disk; -w ends the assertion
      // together with this process, even if it is killed.
      return { method: "caffeinate", file: "caffeinate", args: ["-dims", "-w", String(process.pid)] };
    case "linux":
      return {
        method: "systemd-inhibit",
        file: "systemd-inhibit",
        args: ["--what=idle:sleep", "--who=animbench", "--why=measurement in progress", "--mode=block", "sleep", "infinity"],
      };
    case "win32":
      return { method: "SetThreadExecutionState", file: "powershell", args: ["-NoProfile", "-Command", WINDOWS_SCRIPT] };
    default:
      return null;
  }
}

/**
 * Keeps the machine and its display awake for a whole batch. A sleeping
 * machine stops rendering, so every run until it wakes would time out — an
 * hour of sleep in a long batch is an hour of discarded runs.
 */
export async function keepAwake(): Promise<KeepAwake> {
  const spec = command();
  if (!spec) return { method: null, release: () => undefined };

  const child: ChildProcess = spawn(spec.file, spec.args, { stdio: "ignore" });
  const started = await new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("spawn", () => resolve(true));
  });
  if (!started) return { method: null, release: () => undefined };

  const release = () => {
    if (child.exitCode === null) child.kill();
  };
  // Children outlive their parent unless killed, which would keep the machine
  // awake indefinitely after an interrupted batch.
  process.once("exit", release);
  return {
    method: spec.method,
    release: () => {
      process.off("exit", release);
      release();
    },
  };
}
