import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import path from "node:path";
import { z } from "zod";

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
  return environment;
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

export default async function plugin(bb: BbPluginApi) {
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
