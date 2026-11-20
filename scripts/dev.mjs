// Runs the API and the Expo web app together with prefixed output.
import { spawn } from "node:child_process";

const jobs = [
  { name: "api", color: "\x1b[38;5;173m", cmd: "npm", args: ["--prefix", "server", "start"] },
  { name: "app", color: "\x1b[38;5;109m", cmd: "npm", args: ["--prefix", "app", "run", "web"] }
];

const reset = "\x1b[0m";

for (const job of jobs) {
  const child = spawn(job.cmd, job.args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
