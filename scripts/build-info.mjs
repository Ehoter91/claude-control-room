// Records which git checkout and commit a build came from, so the app can update itself from it later.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const source = git("rev-parse", "--show-toplevel");
writeFileSync("dist/build-info.json", `${JSON.stringify({ source, commit: git("rev-parse", "--short", "HEAD"), builtAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`build-info: ${source ?? "not a git checkout"}`);
