import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Exercise acquisition and the shipped artifact. Never install or reload a daemon plugin.
const root = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) {
  throw new Error("Run this verifier with npm run verify:install.");
}
const args = process.argv.slice(2);
if (args.length > 1) throw new Error("Usage: npm run verify:install -- [new-output-directory]");
const output = args[0] ? path.resolve(args[0]) : mkdtempSync(path.join(tmpdir(), "antigravity-install-"));
if (output === root || output.startsWith(root + path.sep)) {
  throw new Error("The output directory must be outside the source checkout.");
}
if (args[0] && existsSync(output)) throw new Error("Choose a new output directory; existing evidence is preserved.");
mkdirSync(output, { recursive: true });
console.log(`Installation evidence: ${output}`);
const snapshot = path.join(output, "source");
mkdirSync(snapshot);
for (const name of [
  "package.json", "package-lock.json", "paseo-plugin.json", "tsconfig.json", ".gitignore",
  "index.server.ts", "icon.svg", "README.md", "OVERVIEW.md", "THIRD_PARTY_NOTICES.md", "LICENSE.paseo",
  "server", "shared", "scripts", "test", "docs",
]) {
  if (existsSync(path.join(root, name))) cpSync(path.join(root, name), path.join(snapshot, name), { recursive: true });
}

const steps = [];
function run(name, argv, cwd = snapshot, executable = process.execPath) {
  const result = spawnSync(executable, argv, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(path.join(output, `${name}.stdout.log`), result.stdout ?? "");
  writeFileSync(path.join(output, `${name}.stderr.log`), result.stderr ?? "");
  steps.push({ name, argv, cwd, status: result.status, error: result.error?.message });
  writeFileSync(path.join(output, "steps.json"), JSON.stringify(steps, null, 2) + "\n");
  if (result.error || result.status !== 0) {
    throw new Error(`${name} failed. See ${output} (${result.error?.message ?? `exit ${result.status}`}).`);
  }
  console.log(`${name}: passed`);
  return result.stdout;
}
run("npm-ci", [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
run("typecheck", [npmCli, "run", "typecheck"]);
const packed = JSON.parse(run("npm-pack", [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", output]))[0];
writeFileSync(path.join(output, "package-contents.json"), JSON.stringify(packed, null, 2) + "\n");
const paths = new Set(packed.files.map((file) => file.path));
for (const required of ["paseo-plugin.json", "index.server.ts", "OVERVIEW.md", "icon.svg", "THIRD_PARTY_NOTICES.md", "LICENSE.paseo", "docs/UPSTREAM.md"]) {
  if (!paths.has(required)) throw new Error(`The package is missing ${required}`);
}
const consumer = path.join(snapshot, "packed-consumer");
mkdirSync(consumer);
writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
run("install-tarball", [npmCli, "install", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", path.join(output, packed.filename)], consumer);
const packageName = JSON.parse(readFileSync(path.join(snapshot, "package.json"), "utf8")).name;
const entry = path.join(consumer, "node_modules", packageName, "index.server.ts");
// Node deliberately refuses native stripping under node_modules. Compile only the
// packed plugin's TS with the locked TypeScript compiler; all SDK runtime imports
// resolve to the real @getpaseo/plugin installed by npm ci, never the unit-test shim.
const entryCheck = path.join(snapshot, "verify-packed-entry.mjs");
writeFileSync(entryCheck, `
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const entry = process.argv[2];
const pluginPrefix = pathToFileURL(entry.slice(0, -"index.server.ts".length)).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(pluginPrefix) && url.endsWith(".ts")) {
    const result = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const module = await import(pathToFileURL(entry).href);
if (typeof module.default !== "function") throw new Error("Missing plugin contribution function");
console.log("Packed entry linked against the real npm Paseo SDK; no daemon, credentials or agy were accessed.");
`);
run("packed-entry-link", [entryCheck, entry]);
const manifest = JSON.parse(readFileSync(path.join(snapshot, "paseo-plugin.json"), "utf8"));
const summary = {
  node: process.version, platform: process.platform, package: `${packageName}@${packed.version}`,
  fileCount: paths.size, artifact: path.join(output, packed.filename),
  requirements: manifest.requirements,
  result: "clean npm ci, source typecheck, actual npm pack, offline tarball install and real SDK entry linkage passed",
  limits: "Does not start a Paseo daemon or agy, validate full SDK types, exercise model calls, or establish cross-OS behavior.",
};
writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
