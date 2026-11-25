// Runs the API and the Expo web app together with prefixed output.
import { spawn } from "node:child_process";

const jobs = [
  { name: "api", color: "\x1b[38;5;173m", cmd: "npm", args: ["--prefix", "server", "start"] },
  { name: "app", color: "\x1b[38;5;109m", cmd: "npm", args: ["--prefix", "app", "run", "web"] }
];

const reset = "\x1b[0m";

// npm is a shell script on POSIX and a .cmd batch file on Windows. A batch file
// cannot be spawned directly, so Windows runs it through the command
// interpreter; the arguments here are fixed words with no spaces to quote.
function spawnJob(job) {
  const stdio = ["ignore", "pipe", "pipe"];
  if (process.platform === "win32") {
    const line = [job.cmd, ...job.args].join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
      stdio,
      env: process.env,
      windowsHide: true
    });
  }
  return spawn(job.cmd, job.args, { stdio, env: process.env });
}

for (const job of jobs) {
  const child = spawnJob(job);
  const tag = `${job.color}${job.name.padEnd(3)}${reset}`;
  const pipe = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${tag} exited with code ${code}\n`);
    process.exit(code ?? 0);
  });
}

process.on("SIGINT", () => process.exit(0));
