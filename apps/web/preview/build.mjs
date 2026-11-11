// PREVIEW ONLY. Turns a recording into ONE self-contained html file: the real app built by vite (all JS and CSS inlined) plus the replay data.
//   node preview/build.mjs preview-dist/recording.json "what changed 1" "what changed 2" ...
// The file name carries the commit; no server and no network are needed to open it.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const [recordingPath, ...changes] = process.argv.slice(2);
if (!recordingPath) { console.error("usage: node preview/build.mjs <recording.json> [what changed ...]"); process.exit(2); }
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const vite = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");
execFileSync(process.execPath, [vite, "build", "--config", "vite.preview.config.ts", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });

const app = join(root, "preview-dist/app");
let html = readFileSync(join(app, "index.html"), "utf8");
const rec = JSON.parse(readFileSync(resolve(root, recordingPath), "utf8"));
const data = {
  meta: { sha: dirty ? `${sha}+uncommitted` : sha, builtAt: new Date().toISOString(), recordedAt: rec.recordedAt, changes, personas: Object.keys(rec.personas) },
  personas: rec.personas,
};
const escapeScript = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
const asset = (p) => readFileSync(join(app, p.replace(/^\.\//, "")), "utf8");
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/, (_m, src) => `<script type="module">${escapeScript(asset(src))}</script>`);
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/, (_m, href) => `<style>${asset(href)}</style>`);
html = html.replace("__PREVIEW_DATA__", () => escapeScript(JSON.stringify(data)));
if (/(src|href)="(\.\/)?assets\//.test(html)) { console.error("An asset was not inlined; refusing to write a file that needs a server."); process.exit(1); }
// The data tag must come BEFORE the module script (modules run after parsing, so either order works; keeping it first is clearer).
const outDir = join(root, "preview-dist"); mkdirSync(outDir, { recursive: true });
const file = join(outDir, `ogevia-preview-${sha.slice(0, 7)}${dirty ? "-uncommitted" : ""}.html`);
writeFileSync(file, html);
console.log(`${file} (${(html.length / 1e6).toFixed(2)} MB)`);
