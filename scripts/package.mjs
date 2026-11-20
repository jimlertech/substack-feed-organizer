// Builds the store upload: dist/feed-organizer-<version>.zip with only the files the extension loads.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const files = ["manifest.json", "background.js", "content.css", "content.js", "core.js", "width-early.js", "icons"];
const out = `dist/feed-organizer-${manifest.version}.zip`;

mkdirSync("dist", { recursive: true });
rmSync(out, { force: true });
// Windows and macOS ship bsdtar, which writes a zip archive when the name ends in .zip and -a is set.
execFileSync("tar", ["-a", "-cf", out, ...files], { stdio: "inherit" });
console.log(`Wrote ${out}`);
