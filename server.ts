import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import path from "node:path";
import { z } from "zod";
import {
  symbolNavigationProviders,
  type SymbolSourceProject,
} from "./symbol-provider";

const workspaceEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});
type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
const reviewFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  origin: z.enum(["tracked", "untracked"]),
  loadMode: z.enum(["auto", "on_demand", "too_large"]),
});
const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }),
  z.object({ kind: z.literal("all"), mergeBaseBranch: z.string().min(1) }),
]);
const lastTurnReviewSchema = z.object({
  state: z.enum(["ready", "not_available"]),
  message: z.string().nullable(),
  turnId: z.string().nullable(),
  workspacePath: z.string().nullable(),
  diff: z.string().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
const symbolDefinitionSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string(),
});

export const rpcContract = defineRpcContract({
  workspace: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      state: z.enum(["ready", "not_available"]),
      message: z.string().nullable(),
      rootName: z.string().nullable(),
      truncated: z.boolean(),
      entries: z.array(workspaceEntrySchema),
    }),
  },
  workspaceFile: {
    input: z
      .object({ threadId: z.string(), path: z.string().min(1) })
      .strict(),
    output: z.object({
      state: z.enum(["ready", "not_available", "binary"]),
      message: z.string().nullable(),
      path: z.string().nullable(),
      content: z.string().nullable(),
    }),
  },
  symbolDefinition: {
    input: z.object({
      threadId: z.string(),
      path: z.string().min(1),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    }).strict(),
    output: z.object({
      state: z.enum(["ready", "not_found", "not_available"]),
      providerId: z.string().nullable(),
      providerLabel: z.string().nullable(),
      message: z.string().nullable(),
      definitions: z.array(symbolDefinitionSchema),
    }),
  },
  review: {
    input: z.object({ threadId: z.string(), target: reviewTargetSchema.nullable() }).strict(),
    output: z.object({
      state: z.enum(["ready", "not_available"]),
      message: z.string().nullable(),
      branch: z.string().nullable(),
      baseBranches: z.array(z.string()),
      selectedBaseBranch: z.string().nullable(),
      files: z.array(reviewFileSchema),
      shortstat: z.string(),
      initialPatches: z.array(z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() })),
    }),
  },
  reviewPatches: {
    input: z.object({ threadId: z.string(), target: reviewTargetSchema, paths: z.array(z.string().min(1)).min(1).max(50) }).strict(),
    output: z.object({ patches: z.array(z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() })) }),
  },
  lastTurnReview: {
    input: z.object({ threadId: z.string(), turnId: z.string().min(1).nullable().default(null) }).strict(),
    output: lastTurnReviewSchema,
  },
});

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

async function latestCompletedTurnDiff(
  bb: BbPluginApi,
  threadId: string,
  requestedTurnId: string | null,
): Promise<{ turnId: string; diff: string } | null> {
  // The public event feed is chronological. A generous bounded read keeps
  // this usable for ordinary long-running threads without loading the full
  // history (a diff event can itself be several megabytes).
  const events = await bb.sdk.threads.events.list({ threadId, limit: "5000" });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const completed = events[index];
    if (completed?.type !== "turn/completed" || completed.scope.kind !== "turn") continue;
    if (requestedTurnId !== null && completed.scope.turnId !== requestedTurnId) continue;
    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = events[candidateIndex];
      if (candidate?.type !== "turn/diff/updated") continue;
      if (candidate.scope.kind !== "turn" || candidate.scope.turnId !== completed.scope.turnId) continue;
      const diff = candidate.data.diff;
      return typeof diff === "string" && diff.length > 0
        ? { turnId: completed.scope.turnId, diff }
        : null;
    }
  }
  return null;
}

async function workspaceForThread(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null) return null;
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (environment.path === null) return null;
  return { ...environment, path: environment.path };
}

async function ignoredWorkspacePaths(
  bb: BbPluginApi,
  environmentId: string,
): Promise<Set<string>> {
  const terminal = await bb.sdk.terminals.create({
    cols: 80,
    rows: 8,
    scope: { kind: "environment", environmentId },
    start: {
      mode: "command",
      // `ls-files` lets Git apply all repository ignore sources without
      // sending untrusted filenames through a shell command.
      command:
        "git -c core.quotepath=false ls-files -ci --exclude-standard -z; git -c core.quotepath=false ls-files -oi --exclude-standard -z",
    },
    title: "Change Review: ignored paths",
  });
  try {
    let session = terminal;
    for (let attempt = 0; attempt < 20 && session.status !== "exited"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      session = await bb.sdk.terminals.get({ terminalId: terminal.id });
    }
    const output = await bb.sdk.terminals.output({
      terminalId: terminal.id,
      tailBytes: 2 * 1024 * 1024,
    });
    const text = Buffer.concat(
      output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    ).toString("utf8");
    return new Set(text.split("\0").map((item) => item.trim()).filter(Boolean));
  } finally {
    await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" });
  }
}

async function gitWorkspaceEntries(
  bb: BbPluginApi,
  environmentId: string,
): Promise<WorkspaceEntry[] | null> {
  const terminal = await bb.sdk.terminals.create({
    cols: 80,
    rows: 8,
    scope: { kind: "environment", environmentId },
    start: {
      mode: "command",
      // Git applies repository, global, and info/exclude ignore rules before
      // paths reach the plugin, so ignored trees never consume a listing limit.
      command:
        "printf '__BB_FILES_START__\\0' && git -c core.quotepath=false ls-files --cached --others --exclude-standard -z && printf '__BB_FILES_DONE__\\0'",
    },
    title: "Files: workspace index",
  });
  try {
    let session = terminal;
    for (let attempt = 0; attempt < 100 && session.status !== "exited"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      session = await bb.sdk.terminals.get({ terminalId: terminal.id });
    }
    if (session.status !== "exited" || session.exitCode !== 0) return null;
    const output = await bb.sdk.terminals.output({
      terminalId: terminal.id,
      tailBytes: 4 * 1024 * 1024,
    });
    const text = Buffer.concat(
      output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    ).toString("utf8");
    const paths = text.split("\0");
    const startIndex = paths.indexOf("__BB_FILES_START__");
    const doneIndex = paths.indexOf("__BB_FILES_DONE__", startIndex + 1);
    if (startIndex < 0 || doneIndex < 0) return null;

    const entries = new Map<string, WorkspaceEntry>();
    for (const filePath of paths.slice(startIndex + 1, doneIndex)) {
      if (filePath === "") continue;
      const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
      if (normalizedPath === "") continue;
      entries.set(normalizedPath, { path: normalizedPath, kind: "file" });
      const segments = normalizedPath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const directoryPath = segments.slice(0, index).join("/");
        entries.set(directoryPath, { path: directoryPath, kind: "directory" });
      }
    }
    return [...entries.values()];
  } finally {
    await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" });
  }
}

function safeWorkspacePath(rootPath: string, relativePath: string): string | null {
  if (relativePath.split("/").some((segment) => segment === "..")) return null;
  const candidate = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..")
    ? candidate
    : null;
}

const SYMBOL_PROJECT_MAX_FILES = 1_500;
const SYMBOL_PROJECT_MAX_BYTES = 12 * 1024 * 1024;
const SYMBOL_PROJECT_CACHE_MS = 15_000;

type SymbolProjectCacheEntry = {
  expiresAt: number;
  project: SymbolSourceProject;
};

function packageNameFromImport(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
    : parts[0] ?? null;
}

function importedModules(files: ReadonlyMap<string, string>): { sourcePath: string; specifier: string }[] {
  const modules: { sourcePath: string; specifier: string }[] = [];
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu;
  for (const [sourcePath, content] of files) {
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier !== undefined) modules.push({ sourcePath, specifier });
      if (modules.length >= 400) return modules;
    }
  }
  return modules;
}

function importedPackages(files: ReadonlyMap<string, string>): string[] {
  const packages = new Set<string>();
  for (const { specifier } of importedModules(files)) {
    const packageName = packageNameFromImport(specifier);
    if (packageName !== null) packages.add(packageName);
    if (packages.size >= 24) break;
  }
  return [...packages];
}

function dependencyDeclarationCandidates(files: ReadonlyMap<string, string>): string[] {
  const candidates = new Set<string>();
  for (const { sourcePath, specifier } of importedModules(files)) {
    let base: string | null = null;
    if (specifier.startsWith(".") && sourcePath.startsWith("node_modules/")) {
      base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
    } else if (packageNameFromImport(specifier) !== null) {
      base = `node_modules/${specifier}`;
      const packageName = packageNameFromImport(specifier);
      if (packageName !== null) candidates.add(`node_modules/${packageName}/package.json`);
    }
    if (base === null) continue;
    const extensionless = base.replace(/\.(?:mjs|cjs|js|jsx)$/u, "");
    candidates.add(`${base}.d.ts`);
    candidates.add(`${extensionless}.d.ts`);
    candidates.add(`${base}/index.d.ts`);
  }
  for (const [filePath, content] of files) {
    if (!filePath.endsWith("/package.json")) continue;
    try {
      const packageJson = JSON.parse(content) as { types?: unknown; typings?: unknown };
      const declaration = typeof packageJson.types === "string"
        ? packageJson.types
        : typeof packageJson.typings === "string"
          ? packageJson.typings
          : null;
      if (declaration !== null) {
        candidates.add(path.posix.normalize(path.posix.join(path.posix.dirname(filePath), declaration)));
      }
    } catch {
      // Ignore malformed dependency metadata.
    }
  }
  return [...candidates];
}

async function readSymbolFiles(
  bb: BbPluginApi,
  environment: NonNullable<Awaited<ReturnType<typeof workspaceForThread>>>,
  relativePaths: readonly string[],
  files: Map<string, string>,
): Promise<void> {
  let totalBytes = [...files.values()].reduce((total, content) => total + content.length, 0);
  for (let offset = 0; offset < relativePaths.length; offset += 16) {
    if (files.size >= SYMBOL_PROJECT_MAX_FILES || totalBytes >= SYMBOL_PROJECT_MAX_BYTES) break;
    const batch = relativePaths.slice(offset, offset + 16);
    const results = await Promise.all(batch.map(async (relativePath) => {
      if (files.has(relativePath)) return null;
      const absolutePath = safeWorkspacePath(environment.path, relativePath);
      if (absolutePath === null) return null;
      try {
        const result = await bb.sdk.files.read({
          hostId: environment.hostId,
          path: absolutePath,
          rootPath: environment.path,
        });
        if (result.contentEncoding !== "utf8" || result.sizeBytes > 1024 * 1024) return null;
        return { path: relativePath.replaceAll("\\", "/"), content: result.content };
      } catch {
        return null;
      }
    }));
    for (const result of results) {
      if (result === null || files.size >= SYMBOL_PROJECT_MAX_FILES) continue;
      if (totalBytes + result.content.length > SYMBOL_PROJECT_MAX_BYTES) break;
      files.set(result.path, result.content);
      totalBytes += result.content.length;
    }
  }
}

async function buildSymbolProject(
  bb: BbPluginApi,
  environment: NonNullable<Awaited<ReturnType<typeof workspaceForThread>>>,
): Promise<SymbolSourceProject> {
  const gitEntries = environment.isGitRepo
    ? await gitWorkspaceEntries(bb, environment.id).catch(() => null)
    : null;
  const workspaceEntries = gitEntries ?? (await bb.sdk.files.listPaths({
    hostId: environment.hostId,
    path: environment.path,
    limit: SYMBOL_PROJECT_MAX_FILES,
    includeFiles: true,
    includeDirectories: false,
  })).paths;
  const projectPaths = workspaceEntries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path.replaceAll("\\", "/"))
    .filter((filePath) =>
      filePath.endsWith("package.json") ||
      symbolNavigationProviders.some((provider) => provider.supports(filePath))
    )
    .slice(0, SYMBOL_PROJECT_MAX_FILES);
  const files = new Map<string, string>();
  await readSymbolFiles(bb, environment, projectPaths, files);

  for (let round = 0; round < 3; round += 1) {
    const sizeBefore = files.size;
    await readSymbolFiles(
      bb,
      environment,
      dependencyDeclarationCandidates(files),
      files,
    );
    if (files.size === sizeBefore) break;
  }

  // Best-effort external dependency indexing. Only packages actually imported
  // by project sources are traversed, and only declaration files are retained.
  for (const packageName of importedPackages(files)) {
    if (files.size >= SYMBOL_PROJECT_MAX_FILES) break;
    const dependencyRoot = path.join(environment.path, "node_modules", packageName);
    try {
      const result = await bb.sdk.files.listPaths({
        hostId: environment.hostId,
        path: dependencyRoot,
        limit: 250,
        includeFiles: true,
        includeDirectories: false,
      });
      const dependencyPaths = result.paths
        .filter((entry) => entry.kind === "file")
        .map((entry) => `node_modules/${packageName}/${entry.path.replaceAll("\\", "/")}`)
        .filter((filePath) => filePath.endsWith(".d.ts") || filePath.endsWith("package.json"));
      await readSymbolFiles(bb, environment, dependencyPaths, files);
    } catch {
      // Dependencies are optional: workspace navigation remains useful when
      // node_modules is absent or lives outside the workspace.
    }
  }
  return { files };
}

export default async function plugin(bb: BbPluginApi) {
  const symbolProjects = new Map<string, SymbolProjectCacheEntry>();
  bb.rpc.register(rpcContract, {
    async workspace({ threadId }) {
      const environment = await workspaceForThread(bb, threadId);
      if (environment === null || environment.path === null) {
        return {
          state: "not_available" as const,
          message: "This thread has no browsable workspace environment.",
          rootName: null,
          truncated: false,
          entries: [],
        };
      }
      const gitEntries = environment.isGitRepo
        ? await gitWorkspaceEntries(bb, environment.id).catch(() => null)
        : null;
      if (gitEntries !== null) {
        return {
          state: "ready" as const,
          message: null,
          rootName: path.basename(environment.path),
          truncated: false,
          entries: gitEntries,
        };
      }

      const [result, ignoredPaths] = await Promise.all([
        bb.sdk.files.listPaths({
        hostId: environment.hostId,
        path: environment.path,
        limit: 10_000,
        includeFiles: true,
        includeDirectories: true,
        }),
        ignoredWorkspacePaths(bb, environment.id).catch(() => new Set<string>()),
      ]);
      const visibleEntries = result.paths.filter((entry) => {
        if (entry.kind === "file") return !ignoredPaths.has(entry.path);
        const directoryPrefix = entry.path + "/";
        return ![...ignoredPaths].some((ignoredPath) =>
          ignoredPath.startsWith(directoryPrefix),
        );
      });
      return {
        state: "ready" as const,
        message: null,
        rootName: path.basename(environment.path),
        truncated: result.truncated,
        entries: visibleEntries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
        })),
      };
    },
    async workspaceFile({ threadId, path: relativePath }) {
      const environment = await workspaceForThread(bb, threadId);
      if (environment === null || environment.path === null) {
        return {
          state: "not_available" as const,
          message: "This thread has no browsable workspace environment.",
          path: null,
          content: null,
        };
      }
      const absolutePath = safeWorkspacePath(environment.path, relativePath);
      if (absolutePath === null) {
        throw new Error("The requested file is outside the workspace.");
      }
      const result = await bb.sdk.files.read({
        hostId: environment.hostId,
        path: absolutePath,
        rootPath: environment.path,
      });
      if (result.contentEncoding !== "utf8") {
        return {
          state: "binary" as const,
          message: "Binary files cannot be previewed here.",
          path: relativePath,
          content: null,
        };
      }
      return {
        state: "ready" as const,
        message: null,
        path: relativePath,
        content: result.content,
      };
    },
    async symbolDefinition({ threadId, path: relativePath, line, column }) {
      const provider = symbolNavigationProviders.find((candidate) =>
        candidate.supports(relativePath),
      );
      if (provider === undefined) {
        return {
          state: "not_available" as const,
          providerId: null,
          providerLabel: null,
          message: "No symbol navigation provider is connected for this file type.",
          definitions: [],
        };
      }
      const environment = await workspaceForThread(bb, threadId);
      if (environment === null || environment.path === null) {
        return {
          state: "not_available" as const,
          providerId: provider.id,
          providerLabel: provider.label,
          message: "This thread has no browsable workspace environment.",
          definitions: [],
        };
      }
      const cached = symbolProjects.get(environment.id);
      const project = cached !== undefined && cached.expiresAt > Date.now()
        ? cached.project
        : await buildSymbolProject(bb, environment);
      symbolProjects.set(environment.id, {
        expiresAt: Date.now() + SYMBOL_PROJECT_CACHE_MS,
        project,
      });
      const definitions = provider.findDefinitions(project, {
        path: relativePath,
        line,
        column,
      });
      return definitions.length === 0
        ? {
            state: "not_found" as const,
            providerId: provider.id,
            providerLabel: provider.label,
            message: "The provider did not find a definition for this symbol.",
            definitions: [],
          }
        : {
            state: "ready" as const,
            providerId: provider.id,
            providerLabel: provider.label,
            message: null,
            definitions,
          };
    },
    async review({ threadId, target }) {
      const environment = await workspaceForThread(bb, threadId);
      if (environment === null || !environment.isGitRepo) {
        return { state: "not_available" as const, message: "This thread has no Git workspace to review.", branch: null, baseBranches: [], selectedBaseBranch: null, files: [], shortstat: "", initialPatches: [] };
      }
      const branches = await bb.sdk.environments.diffBranches({ environmentId: environment.id, limit: "200", ...(environment.branchName ? { selectedBranch: environment.branchName } : {}) });
      const baseBranches = [...new Set([...branches.branches, ...branches.remoteBranches])];
      const selectedBaseBranch = target?.kind === "all"
        ? target.mergeBaseBranch
        : environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch ?? baseBranches[0] ?? null;
      const diffTarget = target?.kind === "uncommitted" || selectedBaseBranch === null
        ? { target: "uncommitted" as const }
        : { target: "all" as const, mergeBaseBranch: selectedBaseBranch };
      const result = await bb.sdk.environments.diffFiles({ environmentId: environment.id, ...diffTarget });
      if (result.outcome !== "available") {
        return { state: "not_available" as const, message: result.outcome === "unavailable" ? result.failure.message : result.message, branch: environment.branchName, baseBranches, selectedBaseBranch, files: [], shortstat: "", initialPatches: [] };
      }
      return { state: "ready" as const, message: null, branch: environment.branchName, baseBranches, selectedBaseBranch, files: result.files, shortstat: result.shortstat, initialPatches: result.initialPatches };
    },
    async reviewPatches({ threadId, target, paths }) {
      const environment = await workspaceForThread(bb, threadId);
      if (environment === null || !environment.isGitRepo) return { patches: [] };
      const diffTarget = target.kind === "uncommitted" ? { type: "uncommitted" as const } : { type: "all" as const, mergeBaseBranch: target.mergeBaseBranch };
      const result = await bb.sdk.environments.diffPatch({ environmentId: environment.id, target: diffTarget, paths });
      return { patches: result.outcome === "available" ? result.patches : [] };
    },
    async lastTurnReview({ threadId, turnId }) {
      const environment = await workspaceForThread(bb, threadId);
      const result = await latestCompletedTurnDiff(bb, threadId, turnId);
      if (result === null) {
        return {
          state: "not_available" as const,
          message: "No saved diff is available for the last completed turn.",
          turnId: null,
          workspacePath: environment?.path ?? null,
          diff: null,
          additions: 0,
          deletions: 0,
        };
      }
      return {
        state: "ready" as const,
        message: null,
        turnId: result.turnId,
        workspacePath: environment?.path ?? null,
        diff: result.diff,
        ...diffStats(result.diff),
      };
    },
  });

  bb.agents.contributeInstructions(() =>
    "When a completed turn changes files, append this standalone Markdown directive after your final response: ::change-review-last-turn{}. Do not mention the directive in prose. It renders the turn's compact change-review card.",
  );
}
