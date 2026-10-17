// Folds the counter build into one HTML file: the module script and the
// stylesheet are inlined, and the asset files are removed. Fails if anything
// in the result still points at another file or a remote origin.
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(import.meta.dirname, "..", "dist-counter");
const htmlPath = join(dir, "counter.html");
let html = readFileSync(htmlPath, "utf8");

const read = (ref) => readFileSync(join(dir, ref.replace(/^\.\//, "")), "utf8");

html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_, src) => {
  // A literal closing tag inside the code would end the inline script early.
  const code = read(src).replace(/<\/script/gi, "<\\/script");
  return `<script type="module">${code}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_, href) => `<style>${read(href)}</style>`);

if (/<script[^>]+src=|<link[^>]+href=|url\((?!["']?data:)|https?:\/\/(?!www\.w3\.org)/i.test(html.replace(/<script type="module">[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, (css) => css.replace(/url\(["']?data:[^)]*\)/g, "")))) {
  throw new Error("counter.html still references an external file or origin");
}

// House rule: no em dashes in anything shipped. The only ones are in bundled
// SDK error messages; a hyphen reads the same there.
html = html.replaceAll(String.fromCharCode(0x2014), "-");

writeFileSync(htmlPath, html);
for (const entry of readdirSync(dir)) if (entry !== "counter.html") rmSync(join(dir, entry), { recursive: true, force: true });
console.log(`counter.html ${Buffer.byteLength(html)} bytes, self-contained`);
