// House-rule check: no em dashes anywhere in tracked source, docs or copy.
// Usage: node scripts/check-text.mjs [path...]   (defaults to the repo root)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const EM_DASH = String.fromCharCode(0x2014);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".vite", "coverage"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".css", ".svg", ".yml", ".yaml", ".toml", ".txt", ".example", ""]);
const SKIP_FILES = new Set(["package-lock.json"]);

const roots = process.argv.slice(2);
const hits = [];

function scanFile(path) {
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.includes(EM_DASH)) hits.push(`${relative(process.cwd(), path)}:${index + 1}`);
    });
}

function walk(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    if (stat.size < 2_000_000) scanFile(path);
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const child = join(path, name);
    if (statSync(child).isDirectory() || TEXT_EXT.has(extname(name))) walk(child);
  }
}

for (const root of roots.length ? roots : ["."]) walk(root);

if (hits.length) {
  console.error(`em dash found in ${hits.length} place(s):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("check-text: no em dashes");
