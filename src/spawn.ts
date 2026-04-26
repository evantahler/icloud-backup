export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}
