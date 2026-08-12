import ts from "typescript";

export type SymbolDefinition = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

export type SymbolDefinitionRequest = {
  path: string;
  line: number;
  column: number;
};

export type SymbolSourceProject = {
  files: ReadonlyMap<string, string>;
};

export interface SymbolNavigationProvider {
  readonly id: string;
  readonly label: string;
  supports(path: string): boolean;
  findDefinitions(
    project: SymbolSourceProject,
    request: SymbolDefinitionRequest,
  ): SymbolDefinition[];
}

const TYPE_SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SOURCE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.d.ts",
] as const;

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function extensionFor(filePath: string): ts.Extension {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".d.ts")) return ts.Extension.Dts;
  if (lower.endsWith(".tsx")) return ts.Extension.Tsx;
  if (lower.endsWith(".jsx")) return ts.Extension.Jsx;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.Extension.Js;
  }
  if (lower.endsWith(".json")) return ts.Extension.Json;
  return ts.Extension.Ts;
}

function dirname(filePath: string): string {
  const normalized = normalizePath(filePath);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function collapsePath(filePath: string): string {
  const parts: string[] = [];
  for (const part of normalizePath(filePath).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveModulePath(
  moduleName: string,
  containingPath: string,
  files: ReadonlyMap<string, string>,
): string | null {
  const normalizedModule = normalizePath(moduleName);
  const bases: string[] = [];
  if (moduleName.startsWith(".")) {
    bases.push(collapsePath(`${dirname(containingPath)}/${normalizedModule}`));
  } else {
    // Common workspace aliases and package-style imports. This intentionally
    // stays heuristic: the provider boundary lets a future LSP/IDE adapter
    // replace it without changing the UI.
    bases.push(normalizedModule.replace(/^@\//u, ""));
    bases.push(`node_modules/${normalizedModule}`);
    for (const filePath of files.keys()) {
      const packageRoot = filePath.endsWith("/package.json")
        ? filePath.slice(0, -"/package.json".length)
        : filePath === "package.json"
          ? ""
          : null;
      if (packageRoot === null) continue;
      try {
        const packageJson = JSON.parse(files.get(filePath) ?? "") as {
          name?: unknown;
          types?: unknown;
          typings?: unknown;
        };
        if (packageJson.name !== moduleName) continue;
        const declaration = typeof packageJson.types === "string"
          ? packageJson.types
          : typeof packageJson.typings === "string"
            ? packageJson.typings
            : "index";
        bases.push(collapsePath(`${packageRoot}/${declaration}`));
      } catch {
        // A malformed package manifest should not disable navigation elsewhere.
      }
    }
  }

  const expandedBases = bases.flatMap((base) =>
    /\.(?:mjs|cjs|js|jsx)$/u.test(base)
      ? [base, base.replace(/\.(?:mjs|cjs|js|jsx)$/u, "")]
      : [base],
  );
  for (const base of expandedBases) {
    for (const suffix of SOURCE_SUFFIXES) {
      const candidate = `${base}${suffix}`;
      if (files.has(candidate)) return candidate;
    }
  }
  return null;
}

function linePreview(content: string, line: number): string {
  return content.split(/\r?\n/u)[line - 1]?.trim().slice(0, 240) ?? "";
}

export const typeScriptSymbolProvider: SymbolNavigationProvider = {
  id: "typescript",
  label: "TypeScript",
  supports(filePath) {
    const lower = normalizePath(filePath).toLowerCase();
    return [...TYPE_SCRIPT_EXTENSIONS].some((extension) => lower.endsWith(extension));
  },
  findDefinitions(project, request) {
    const files = new Map(
      [...project.files].map(([filePath, content]) => [normalizePath(filePath), content]),
    );
    const requestPath = normalizePath(request.path);
    const requestContent = files.get(requestPath);
    if (requestContent === undefined) return [];

    const versions = new Map([...files.keys()].map((filePath) => [filePath, "1"]));
    const compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      allowNonTsExtensions: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ES2022,
    };
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => compilerOptions,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => "/lib.d.ts",
      getScriptFileNames: () => [...files.keys()],
      getScriptSnapshot: (fileName) => {
        const content = files.get(normalizePath(fileName));
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      getScriptVersion: (fileName) => versions.get(normalizePath(fileName)) ?? "0",
      fileExists: (fileName) => files.has(normalizePath(fileName)),
      readFile: (fileName) => files.get(normalizePath(fileName)),
      readDirectory: () => [...files.keys()],
      resolveModuleNames: (moduleNames, containingFile) =>
        moduleNames.map((moduleName) => {
          const resolvedPath = resolveModulePath(
            moduleName,
            normalizePath(containingFile),
            files,
          );
          return resolvedPath === null
            ? undefined
            : {
                resolvedFileName: resolvedPath,
                extension: extensionFor(resolvedPath),
                isExternalLibraryImport: !moduleName.startsWith("."),
              };
        }),
    };
    const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
    try {
      const sourceFile = languageService.getProgram()?.getSourceFile(requestPath);
      if (sourceFile === undefined) return [];
      const lineCount = Math.max(1, requestContent.split(/\r?\n/u).length);
      const line = Math.min(Math.max(0, request.line - 1), lineCount - 1);
      const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
      const nextLineStart = line + 1 < lineCount
        ? sourceFile.getPositionOfLineAndCharacter(line + 1, 0)
        : sourceFile.getFullText().length;
      const position = Math.min(
        nextLineStart,
        lineStart + Math.max(0, request.column - 1),
      );
      const definitions = languageService.getDefinitionAtPosition(requestPath, position) ?? [];
      const unique = new Map<string, SymbolDefinition>();
      for (const definition of definitions) {
        const definitionPath = normalizePath(definition.fileName);
        const content = files.get(definitionPath);
        const definitionSource = languageService.getProgram()?.getSourceFile(definition.fileName)
          ?? languageService.getProgram()?.getSourceFile(definitionPath);
        if (content === undefined || definitionSource === undefined) continue;
        const location = definitionSource.getLineAndCharacterOfPosition(definition.textSpan.start);
        const result: SymbolDefinition = {
          path: definitionPath,
          line: location.line + 1,
          column: location.character + 1,
          preview: linePreview(content, location.line + 1),
        };
        unique.set(`${result.path}:${result.line}:${result.column}`, result);
      }
      return [...unique.values()];
    } finally {
      languageService.dispose();
    }
  },
};

export const symbolNavigationProviders: readonly SymbolNavigationProvider[] = [
  typeScriptSymbolProvider,
];
