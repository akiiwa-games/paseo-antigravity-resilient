import { createRequire } from "node:module";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const requireFromPlugin = createRequire(path.join(pluginRoot, "package.json"));
let ts;
try {
  ts = requireFromPlugin("typescript");
} catch (error) {
  console.error("TypeScript is unavailable. Run npm ci --ignore-scripts in this checkout.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const configPath = path.join(pluginRoot, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext([configFile.error], {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => pluginRoot,
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  pluginRoot,
);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: {
    ...parsed.options,
    noEmit: true,
  },
});

const diagnostics = [
  ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program),
];

if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => pluginRoot,
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}

console.log(
  `Typecheck passed (${parsed.fileNames.length} files, TypeScript ${ts.version}).`,
);
