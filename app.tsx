import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import "./app.css";

type WorkspaceEntry = { path: string; kind: "file" | "directory" };
type WorkspaceResult = { state: "ready" | "not_available"; message: string | null; rootName: string | null; truncated: boolean; entries: WorkspaceEntry[] };
type WorkspaceFileResult = { state: "ready" | "not_available" | "binary"; message: string | null; path: string | null; content: string | null };
type TreeNode = { name: string; path: string; kind: "file" | "directory"; children: TreeNode[] };
type ReviewTarget = { kind: "uncommitted" } | { kind: "all"; mergeBaseBranch: string };
type ReviewFile = { path: string; previousPath: string | null; changeKind: string; additions: number; deletions: number; binary: boolean; origin: string; loadMode: string };
type ReviewResult = { state: "ready" | "not_available"; message: string | null; branch: string | null; baseBranches: string[]; selectedBaseBranch: string | null; files: ReviewFile[]; shortstat: string; initialPatches: { path: string; patch: string; truncated: boolean }[] };
type LastTurnReview = { state: "ready" | "not_available"; message: string | null; turnId: string | null; workspacePath: string | null; diff: string | null; additions: number; deletions: number };
type TurnChangeFile = { path: string; additions: number; deletions: number; patch: string };
type ReviewSidebarFile = { path: string; additions: number; deletions: number };
type DiffStyle = "unified" | "split";

function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = entry.path.split("/");
    let children = roots;
    for (let index = 0; index < parts.length; index += 1) {
      const segmentPath = parts.slice(0, index + 1).join("/");
      let node = nodes.get(segmentPath);
      if (!node) {
        node = { name: parts[index] ?? segmentPath, path: segmentPath, kind: index === parts.length - 1 ? entry.kind : "directory", children: [] };
        nodes.set(segmentPath, node);
        children.push(node);
      }
      if (index === parts.length - 1) node.kind = entry.kind;
      children = node.children;
    }
  }
  const sortNodes = (items: TreeNode[]) => {
    items.sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name));
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

function fileIcon(name: string): { label: string; tone: string } {
  const lower = name.toLowerCase();
  if (lower === ".gitignore" || lower.startsWith(".git")) return { label: "◇", tone: "git" };
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return { label: "⚛", tone: "react" };
  if (lower.endsWith(".ts")) return { label: "TS", tone: "ts" };
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return { label: "JS", tone: "js" };
  if (lower.endsWith(".json")) return { label: "{}", tone: "json" };
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return { label: "CSS", tone: "css" };
  if (lower.endsWith(".md") || lower === "readme") return { label: "M↓", tone: "md" };
  if (lower.endsWith(".html")) return { label: "<>", tone: "html" };
  if (lower.endsWith(".sql")) return { label: "▤", tone: "sql" };
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return { label: "YML", tone: "yaml" };
  return { label: "•", tone: "file" };
}

function languageFor(path: string): string | null {
  const extension = path.toLowerCase().split(".").at(-1);
  const languages: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", css: "css", html: "xml", md: "markdown", sql: "sql", yml: "yaml", yaml: "yaml", sh: "bash", zsh: "bash", py: "python", java: "java", go: "go", rs: "rust", xml: "xml" };
  return extension === undefined ? null : languages[extension] ?? null;
}

function workspaceRelativePath(path: string, workspacePath: string | null): string {
  if (workspacePath === null) return path;
  const normalizedRoot = workspacePath.replace(/[\\/]+$/u, "");
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRootPath = normalizedRoot.replaceAll("\\", "/");
  return normalizedPath.startsWith(`${normalizedRootPath}/`)
    ? normalizedPath.slice(normalizedRootPath.length + 1)
    : path;
}

function diffRootPath(paths: readonly string[], workspacePath: string | null): string | null {
  const normalizedPaths = paths.map((path) => path.replaceAll("\\", "/"));
  const normalizedWorkspace = workspacePath?.replaceAll("\\", "/").replace(/\/+$/u, "") ?? null;
  if (normalizedWorkspace !== null && normalizedPaths.every((path) => path.startsWith(`${normalizedWorkspace}/`))) {
    return normalizedWorkspace;
  }
  const absolutePaths = normalizedPaths.filter((path) => path.startsWith("/"));
  if (absolutePaths.length !== normalizedPaths.length || absolutePaths.length === 0) return workspacePath;
  const segments = absolutePaths.map((path) => path.split("/").slice(0, -1));
  const shared: string[] = [];
  for (let index = 0; ; index += 1) {
    const candidate = segments[0]?.[index];
    if (candidate === undefined || !segments.every((path) => path[index] === candidate)) break;
    shared.push(candidate);
  }
  return shared.length > 1 ? shared.join("/") || "/" : workspacePath;
}

function reviewFileId(path: string): string {
  return `cr-review-file-${encodeURIComponent(path)}`;
}

function CodePreview({ file }: { file: WorkspaceFileResult }) {
  const composer = useComposer();
  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  if (file.state !== "ready" || file.content === null || file.path === null) return <p className="p-5 text-sm text-muted-foreground">{file.message}</p>;
  if (file.path.toLowerCase().endsWith(".md")) {
    return <article className="cr-markdown p-5"><div className="cr-markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{file.content}</ReactMarkdown></div></article>;
  }
  const language = languageFor(file.path);
  const lines = file.content.split("\n");
  const highlightLine = (line: string) => {
    try { return language ? hljs.highlight(line, { language, ignoreIllegals: true }).value : hljs.highlightAuto(line).value; } catch { return line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
  };
  const addCommentToChat = () => {
    const text = comment.trim();
    if (commentLine === null || text.length === 0) return;
    composer.addQuote(`Comment on \`${file.path}:L${commentLine}\`\n\n${text}`);
    setComment("");
    setCommentLine(null);
  };
  return <div className="cr-code min-w-max p-4"><div className="cr-code-lines">{lines.map((line, index) => <div className="cr-code-line" key={index}><span className="cr-code-line-number" aria-hidden="true">{index + 1}</span><code dangerouslySetInnerHTML={{ __html: highlightLine(line) }} /><button className="cr-code-comment-button" type="button" aria-label={`Add comment on line ${index + 1}`} onClick={() => setCommentLine(index + 1)}>+</button></div>)}</div>{commentLine !== null ? <form className="cr-review-comment-form cr-file-comment-form" onSubmit={(event) => { event.preventDefault(); addCommentToChat(); }}><div className="cr-review-comment-title"><strong>Local comment</strong><span>Comment on line L{commentLine}</span></div><textarea value={comment} autoFocus placeholder="Add a comment" aria-label={`Comment on ${file.path} line ${commentLine}`} onChange={(event) => setComment(event.target.value)} /><div className="cr-review-comment-actions"><button type="button" onClick={() => { setComment(""); setCommentLine(null); }}>Cancel</button><button type="submit" disabled={comment.trim().length === 0}>Add to chat</button></div></form> : null}</div>;
}

function FileBreadcrumbs({ rootName, path, tree, onSelect }: { rootName: string | null; path: string | null; tree: TreeNode[]; onSelect: (path: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const parts = path?.split("/") ?? [];
  const openBrowser = (throughPath: string | null) => {
    if (throughPath !== null) {
      const segments = throughPath.split("/");
      setExpanded((current) => {
        const next = new Set(current);
        for (let index = 1; index <= segments.length; index += 1) next.add(segments.slice(0, index).join("/"));
        return next;
      });
    }
    setIsOpen(true);
  };
  const toggleFolder = (folderPath: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(folderPath)) next.delete(folderPath); else next.add(folderPath);
    return next;
  });
  return <nav className="cr-breadcrumbs" aria-label="File path">
    <button className="cr-crumb" onClick={() => openBrowser(null)}>{rootName ?? "Files"}</button>
    {parts.map((part, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      const isCurrent = index === parts.length - 1;
      return <span className="contents" key={nodePath}><span className="cr-crumb-separator">›</span><button className={`cr-crumb ${isCurrent ? "cr-crumb-current" : ""}`} onClick={() => openBrowser(isCurrent ? parts.slice(0, -1).join("/") || null : nodePath)}>{part}</button></span>;
    })}
    {isOpen ? <><button className="cr-crumb-menu-backdrop" aria-label="Close path menu" onClick={() => setIsOpen(false)} /><div className="cr-crumb-menu"><TreeItems items={tree} selectedPath={path} filter="" expanded={expanded} onToggle={toggleFolder} onSelect={(nextPath) => { setIsOpen(false); onSelect(nextPath); }} /></div></> : null}
  </nav>;
}

function FileIcon({ name }: { name: string }) { const icon = fileIcon(name); return <span className={`cr-file-icon cr-file-icon-${icon.tone}`} aria-hidden="true">{icon.label}</span>; }
function OpenFileIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" /></svg>; }

function ChangeReviewPanel({ threadId, params }: PluginThreadPanelProps) {
  const initialPath =
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.path === "string"
      ? params.path
      : null;
  return <main className="flex h-full min-h-0 flex-col bg-background text-foreground"><FilesTab threadId={threadId} initialPath={initialPath} /></main>;
}
function FileBrowserIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2H18.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" /><path d="M7 4.5h3l2 2" /><path d="M7.5 11.5h9" /></svg>; }

function FilesTab({ threadId, initialPath }: { threadId: string; initialPath: string | null }) {
  const rpc = useRpc<typeof rpcContract>(); const panelRef = useRef<HTMLDivElement | null>(null);
  const navigate = useBbNavigate();
  const [workspace, setWorkspace] = useState<WorkspaceResult | null>(null); const [file, setFile] = useState<WorkspaceFileResult | null>(null); const [filter, setFilter] = useState(""); const [error, setError] = useState<string | null>(null); const [sidebarWidth, setSidebarWidth] = useState(320); const [expanded, setExpanded] = useState<Set<string>>(() => new Set()); const [isBrowserVisible, setIsBrowserVisible] = useState(true);
  const load = useCallback(async () => { setError(null); try { setWorkspace(await rpc.call("workspace", { threadId })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load workspace."); } }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (initialPath === null) {
      setFile(null);
      return;
    }
    void rpc
      .call("workspaceFile", { threadId, path: initialPath })
      .then(setFile)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to open file.",
        ),
      );
  }, [initialPath, rpc, threadId]);
  const openFileTab = useCallback((path: string) => {
    navigate.openThreadPanel({
      actionId: "files",
      title: path.split("/").at(-1) ?? path,
      params: { path },
      experimental_filePath: path,
    });
  }, [navigate]);
  const tree = useMemo(() => workspace !== null && workspace.state === "ready" ? buildTree(workspace.entries) : [], [workspace]);
  const toggleFolder = useCallback((folderPath: string) => setExpanded((current) => { const next = new Set(current); if (next.has(folderPath)) next.delete(folderPath); else next.add(folderPath); return next; }), []);
  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => { event.preventDefault(); const move = (moveEvent: PointerEvent) => { const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth; setSidebarWidth(Math.min(640, Math.max(220, right - moveEvent.clientX))); }; const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); }, []);
  const readyWorkspace = workspace?.state === "ready" ? workspace : null;
  const content = error !== null
    ? <EmptyState message={error} onReload={load} />
    : workspace === null
      ? <EmptyState message="Loading workspace…" />
      : workspace.state === "not_available"
        ? <EmptyState message={workspace.message ?? "Workspace unavailable."} onReload={load} />
        : <div ref={panelRef} className="flex min-h-0 flex-1"><article className="min-w-0 flex-1 overflow-auto">{file === null ? <p className="p-5 text-sm text-muted-foreground">Select a file — it opens in a new tab.</p> : <CodePreview file={file} />}</article>{isBrowserVisible ? <><div className="cr-resize-handle" onPointerDown={beginResize} role="separator" aria-orientation="vertical" aria-label="Resize file browser" /><aside className="flex shrink-0 flex-col border-l border-border" style={{ width: sidebarWidth }}><div className="border-b border-border p-3"><p className="mb-2 flex items-center gap-2 truncate text-sm font-medium"><span aria-hidden="true">▱</span>{workspace.rootName}</p><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files…" className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" /></div><div className="min-h-0 flex-1 overflow-y-auto py-2"><TreeItems items={tree} selectedPath={initialPath} filter={filter.toLowerCase()} expanded={expanded} onToggle={toggleFolder} onSelect={openFileTab} />{workspace.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">File list is truncated.</p> : null}</div></aside></> : null}</div>;
  return <section className="flex min-h-0 flex-1 flex-col"><header className="cr-files-header"><FileBreadcrumbs rootName={readyWorkspace?.rootName ?? null} path={initialPath} tree={tree} onSelect={openFileTab} /><div className="ml-auto shrink-0"><button className="cr-browser-toggle" data-active={isBrowserVisible ? "true" : "false"} aria-pressed={isBrowserVisible} onClick={() => setIsBrowserVisible((visible) => !visible)} aria-label={isBrowserVisible ? "Hide file browser" : "Show file browser"} title={isBrowserVisible ? "Hide file browser" : "Show file browser"}><FileBrowserIcon /></button></div></header>{content}</section>;
}

function TreeItems({ items, selectedPath, filter, expanded, onToggle, onSelect, depth = 0 }: { items: TreeNode[]; selectedPath: string | null; filter: string; expanded: Set<string>; onToggle: (path: string) => void; onSelect: (path: string) => void; depth?: number }) {
  return <>{items.map((item) => { const matching = filter === "" || item.path.toLowerCase().includes(filter) || item.children.some((child) => child.path.toLowerCase().includes(filter)); const open = filter !== "" || expanded.has(item.path); if (!matching) return null; if (item.kind === "directory") return <div key={item.path}><button onClick={() => onToggle(item.path)} className="flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm font-medium hover:bg-muted/60" style={{ paddingLeft: 12 + depth * 16 }}><span className="w-3 text-xs text-muted-foreground">{open ? "⌄" : "›"}</span><span aria-hidden="true">▱</span><span className="truncate">{item.name}</span></button>{open ? <TreeItems items={item.children} selectedPath={selectedPath} filter={filter} expanded={expanded} onToggle={onToggle} onSelect={onSelect} depth={depth + 1} /> : null}</div>; return <button key={item.path} onClick={() => onSelect(item.path)} className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm ${selectedPath === item.path ? "bg-muted text-foreground" : "hover:bg-muted/60"}`} style={{ paddingLeft: 28 + depth * 16 }}><FileIcon name={item.name} /><span className="truncate">{item.name}</span></button>; })}</>;
}

function ReviewPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const reviewLayoutRef = useRef<HTMLDivElement | null>(null);
  const initialMode =
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    params.mode === "last_turn"
      ? "last_turn"
      : "workspace";
  const requestedTurnId =
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.turnId === "string"
      ? params.turnId
      : null;
  const [mode, setMode] = useState<"workspace" | "last_turn">(initialMode);
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [lastTurn, setLastTurn] = useState<LastTurnReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [patches, setPatches] = useState<Map<string, { patch: string; truncated: boolean }>>(() => new Map());
  const [isFilesSidebarVisible, setIsFilesSidebarVisible] = useState(true);
  const [filesSidebarWidth, setFilesSidebarWidth] = useState(288);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [expandedLastTurnFiles, setExpandedLastTurnFiles] = useState<Set<string>>(() => new Set());
  useEffect(() => { setMode(initialMode); }, [initialMode]);
  const load = useCallback(async () => {
    setError(null);
    try {
      if (mode === "last_turn") {
        setLastTurn(await rpc.call("lastTurnReview", { threadId, turnId: requestedTurnId }));
        return;
      }
      const result = await rpc.call("review", { threadId, target });
      setReview(result);
      setPatches(new Map(result.initialPatches.map((patch) => [patch.path, { patch: patch.patch, truncated: patch.truncated }])));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load review."); }
  }, [mode, requestedTurnId, rpc, target, threadId]);
  useEffect(() => { void load(); }, [load]);
  const activeTarget = target ?? (review === null || review.selectedBaseBranch === null ? { kind: "uncommitted" as const } : { kind: "all" as const, mergeBaseBranch: review.selectedBaseBranch });
  const toggleFile = useCallback(async (file: ReviewFile) => {
    const nextExpanded = !expanded.has(file.path);
    setExpanded((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; });
    if (!nextExpanded || patches.has(file.path) || activeTarget === null || file.loadMode === "too_large") return;
    try {
      const result = await rpc.call("reviewPatches", { threadId, target: activeTarget, paths: [file.path] });
      setPatches((current) => { const next = new Map(current); result.patches.forEach((patch) => next.set(patch.path, { patch: patch.patch, truncated: patch.truncated })); return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load file diff."); }
  }, [activeTarget, expanded, patches, rpc, threadId]);
  const additions = mode === "last_turn" ? lastTurn?.additions ?? 0 : review?.files.reduce((total, file) => total + file.additions, 0) ?? 0;
  const deletions = mode === "last_turn" ? lastTurn?.deletions ?? 0 : review?.files.reduce((total, file) => total + file.deletions, 0) ?? 0;
  const selectedValue = mode === "last_turn" ? "last_turn" : activeTarget?.kind === "uncommitted" ? "uncommitted" : activeTarget?.mergeBaseBranch ?? "";
  const beginSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => {
      const right = reviewLayoutRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      setFilesSidebarWidth(Math.min(640, Math.max(220, right - moveEvent.clientX)));
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }, []);
  const lastTurnFiles = filesFromTurnDiff(lastTurn?.diff ?? "");
  const lastTurnRoot = diffRootPath(lastTurnFiles.map((file) => file.path), lastTurn?.workspacePath ?? null);
  const scrollToReviewFile = useCallback((filePath: string) => {
    window.setTimeout(() => document.getElementById(reviewFileId(filePath))?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }, []);
  const openReviewFile = useCallback(async (filePath: string) => {
    if (mode === "last_turn") {
      setExpandedLastTurnFiles((current) => new Set(current).add(filePath));
      scrollToReviewFile(filePath);
      return;
    }
    const file = review?.files.find((candidate) => candidate.path === filePath);
    if (file === undefined) return;
    if (!expanded.has(filePath)) await toggleFile(file);
    scrollToReviewFile(filePath);
  }, [expanded, mode, review?.files, scrollToReviewFile, toggleFile]);
  const sidebarFiles: ReviewSidebarFile[] = mode === "last_turn"
    ? lastTurnFiles.map(({ path, additions, deletions }) => ({ path: workspaceRelativePath(path, lastTurnRoot), additions, deletions }))
    : (review?.files ?? []).map(({ path, additions, deletions }) => ({ path, additions, deletions }));
  const content = mode === "last_turn"
    ? lastTurn === null
      ? <EmptyState message="Loading last turn…" />
      : lastTurn.state === "not_available"
        ? <EmptyState message={lastTurn.message ?? "Last turn unavailable."} onReload={load} />
        : <LastTurnDiff diff={lastTurn.diff} threadId={threadId} workspacePath={lastTurnRoot} diffStyle={diffStyle} expandedFiles={expandedLastTurnFiles} onExpandedChange={setExpandedLastTurnFiles} />
    : review === null
      ? <EmptyState message="Loading review…" />
      : review.state === "not_available"
        ? <EmptyState message={review.message ?? "Review unavailable."} onReload={load} />
        : <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">{review.files.length === 0 ? <EmptyState message="No changes to review." /> : review.files.map((file) => <ReviewFileCard key={file.path} file={file} patch={patches.get(file.path) ?? null} isExpanded={expanded.has(file.path)} onToggle={() => void toggleFile(file)} diffStyle={diffStyle} />)}</div>;
  return <main className="flex h-full min-h-0 flex-col bg-background text-foreground"><header className="cr-review-header"><span className="text-sm font-medium">Review</span><button className="cr-review-refresh" onClick={() => void load()} title="Refresh review" aria-label="Refresh review">↻</button><button className="cr-browser-toggle" data-active={isFilesSidebarVisible ? "true" : "false"} aria-pressed={isFilesSidebarVisible} onClick={() => setIsFilesSidebarVisible((visible) => !visible)} title={isFilesSidebarVisible ? "Hide changed files" : "Show changed files"} aria-label={isFilesSidebarVisible ? "Hide changed files" : "Show changed files"}><FileBrowserIcon /></button></header>{error !== null ? <EmptyState message={error} onReload={load} /> : <section className="flex min-h-0 flex-1 flex-col"><div className="cr-review-toolbar"><label className="sr-only" htmlFor="review-target">Review changes</label><select id="review-target" className="cr-review-select" value={selectedValue} onChange={(event) => { if (event.target.value === "last_turn") { setMode("last_turn"); return; } setMode("workspace"); setTarget(event.target.value === "uncommitted" ? { kind: "uncommitted" } : { kind: "all", mergeBaseBranch: event.target.value }); }}><option value="last_turn">Last turn</option><option value="uncommitted">Uncommitted changes</option>{review?.selectedBaseBranch ? <option value={review.selectedBaseBranch}>All changes from {review.selectedBaseBranch}</option> : null}{review?.baseBranches.filter((branch) => branch !== review.selectedBaseBranch).map((branch) => <option key={branch} value={branch}>All changes from {branch}</option>)}</select><span className="cr-review-summary">{mode === "last_turn" ? "Last turn" : review?.branch ?? "HEAD"} · <b className="cr-diff-added">+{additions}</b> <b className="cr-diff-deleted">−{deletions}</b></span><DiffStyleToggle value={diffStyle} onChange={setDiffStyle} /></div><div ref={reviewLayoutRef} className="flex min-h-0 flex-1">{content}{isFilesSidebarVisible ? <><div className="cr-resize-handle" onPointerDown={beginSidebarResize} role="separator" aria-orientation="vertical" aria-label="Resize changed files" /><ReviewFilesSidebar files={sidebarFiles} width={filesSidebarWidth} onSelect={(path) => void openReviewFile(path)} /></> : null}</div></section>}</main>;
}

function DiffStyleToggle({ value, onChange }: { value: DiffStyle; onChange: (style: DiffStyle) => void }) {
  return <div className="cr-diff-style-toggle" role="group" aria-label="Diff layout"><button type="button" data-active={value === "unified" ? "true" : "false"} aria-pressed={value === "unified"} title="Unified diff" aria-label="Unified diff" onClick={() => onChange("unified")}><span className="cr-diff-style-icon cr-diff-style-unified" aria-hidden="true"><i /><i /></span></button><button type="button" data-active={value === "split" ? "true" : "false"} aria-pressed={value === "split"} title="Split diff" aria-label="Split diff" onClick={() => onChange("split")}><span className="cr-diff-style-icon cr-diff-style-split" aria-hidden="true"><i /><i /></span></button></div>;
}

function ReviewFilesSidebar({ files, width, onSelect }: { files: readonly ReviewSidebarFile[]; width: number; onSelect: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildTree(files.map((file) => ({ path: file.path, kind: "file" as const }))), [files]);
  const statsByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const toggleFolder = useCallback((folderPath: string) => setExpanded((current) => { const next = new Set(current); if (next.has(folderPath)) next.delete(folderPath); else next.add(folderPath); return next; }), []);
  return <aside className="cr-review-files-sidebar" style={{ width }}><div className="cr-review-files-filter"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files…" aria-label="Filter changed files" /></div><div className="min-h-0 flex-1 overflow-y-auto py-2"><ReviewTreeItems items={tree} expanded={expanded} filter={filter.toLowerCase()} onToggle={toggleFolder} onSelect={onSelect} statsByPath={statsByPath} /></div></aside>;
}

function ReviewTreeItems({ items, expanded, filter, onToggle, onSelect, statsByPath, depth = 0 }: { items: TreeNode[]; expanded: Set<string>; filter: string; onToggle: (path: string) => void; onSelect: (path: string) => void; statsByPath: ReadonlyMap<string, ReviewSidebarFile>; depth?: number }) {
  return <>{items.map((item) => { const matching = filter === "" || item.path.toLowerCase().includes(filter) || item.children.some((child) => child.path.toLowerCase().includes(filter)); if (!matching) return null; const open = filter !== "" || expanded.has(item.path); if (item.kind === "directory") return <div key={item.path}><button type="button" className="cr-review-tree-folder" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => onToggle(item.path)}><span>{open ? "⌄" : "›"}</span><span className="truncate">{item.name}</span></button>{open ? <ReviewTreeItems items={item.children} expanded={expanded} filter={filter} onToggle={onToggle} onSelect={onSelect} statsByPath={statsByPath} depth={depth + 1} /> : null}</div>; const stats = statsByPath.get(item.path); return <button type="button" key={item.path} className="cr-review-tree-file" style={{ paddingLeft: 28 + depth * 16 }} onClick={() => onSelect(item.path)} title={`Open ${item.path} in Files`}><FileIcon name={item.name} /><span className="truncate">{item.name}</span>{stats ? <span className="ml-auto shrink-0"><b className="cr-diff-added">+{stats.additions}</b> <b className="cr-diff-deleted">−{stats.deletions}</b></span> : null}</button>; })}</>;
}

function LastTurnDiff({ diff, threadId, workspacePath, diffStyle, expandedFiles, onExpandedChange }: { diff: string | null; threadId: string; workspacePath: string | null; diffStyle: DiffStyle; expandedFiles: Set<string>; onExpandedChange: (files: Set<string>) => void }) {
  const files = useMemo<readonly FileDiffMetadata[]>(() => {
    if (diff === null || diff.length === 0) return [];
    try { return parsePatchFiles(diff).flatMap((patch) => patch.files); } catch { return []; }
  }, [diff]);
  if (files.length === 0) return <EmptyState message="The saved turn diff could not be parsed." />;
  return <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3"><div className="space-y-2">{files.map((file, index) => { const filePath = workspaceRelativePath(file.name, workspacePath); return <LastTurnFileCard file={file} threadId={threadId} workspacePath={workspacePath} diffStyle={diffStyle} isExpanded={expandedFiles.has(filePath)} onToggle={() => onExpandedChange(new Set(expandedFiles.has(filePath) ? [...expandedFiles].filter((path) => path !== filePath) : [...expandedFiles, filePath]))} key={`${file.name}-${index}`} />; })}</div></div>;
}

function fileDiffStats(file: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks ?? []) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

function ReviewCommentableDiff({ file, path, diffStyle }: { file: FileDiffMetadata; path: string; diffStyle: DiffStyle }) {
  const composer = useComposer();
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [comment, setComment] = useState("");
  const hoveredLineRef = useRef<{ lineNumber: number; side: "additions" | "deletions" } | null>(null);
  const lineLabel = range?.side === "deletions" ? "L" : "R";
  const addCommentToChat = useCallback(() => {
    const text = comment.trim();
    if (range === null || text.length === 0) return;
    composer.addQuote(`Review comment on \`${path}:${lineLabel}${range.start}\`\n\n${text}`);
    setComment("");
    setRange(null);
  }, [comment, composer, lineLabel, path, range]);
  return <div className={`cr-review-diff cr-review-diff-${diffStyle}`}><FileDiff fileDiff={file} options={{ disableFileHeader: true, diffStyle, overflow: "scroll", enableGutterUtility: true, lineHoverHighlight: "line", onLineEnter: ({ lineNumber, annotationSide }) => { hoveredLineRef.current = { lineNumber, side: annotationSide }; } }} renderGutterUtility={(getHoveredLine) => <button className="cr-review-comment-gutter" type="button" aria-label="Add comment on this line" onPointerDown={(event) => { event.preventDefault(); const hoveredLine = getHoveredLine() ?? hoveredLineRef.current; if (hoveredLine !== null && hoveredLine !== undefined) setRange({ start: hoveredLine.lineNumber, end: hoveredLine.lineNumber, side: hoveredLine.side }); }}>+</button>} />{range !== null ? <form className="cr-review-comment-form" onSubmit={(event) => { event.preventDefault(); addCommentToChat(); }}><div className="cr-review-comment-title"><strong>Local comment</strong><span>Comment on line {lineLabel}{range.start}</span></div><textarea value={comment} autoFocus placeholder="Request change" aria-label={`Comment on ${path} line ${lineLabel}${range.start}`} onChange={(event) => setComment(event.target.value)} /><div className="cr-review-comment-actions"><button type="button" onClick={() => { setComment(""); setRange(null); }}>Cancel</button><button type="submit" disabled={comment.trim().length === 0}>Add to chat</button></div></form> : null}</div>;
}

function LastTurnFileCard({ file, threadId, workspacePath, diffStyle, isExpanded, onToggle }: { file: FileDiffMetadata; threadId: string; workspacePath: string | null; diffStyle: DiffStyle; isExpanded: boolean; onToggle: () => void }) {
  const stats = useMemo(() => fileDiffStats(file), [file]);
  const navigate = useBbNavigate();
  const filePath = workspaceRelativePath(file.name, workspacePath);
  const previousPath = file.prevName === undefined ? null : workspaceRelativePath(file.prevName, workspacePath);
  const fullPath = previousPath ? `${previousPath} → ${filePath}` : filePath;
  return <section id={reviewFileId(filePath)} className="cr-review-file"><div className="cr-review-file-header"><button className="cr-review-file-label flex min-w-0 flex-1 items-center gap-2 text-left" type="button" aria-expanded={isExpanded} onClick={onToggle} aria-describedby={`${reviewFileId(filePath)}-path`}><FileIcon name={filePath} /><span className="truncate font-mono text-xs">{reviewFileLabel(filePath, previousPath)}</span><span className="ml-auto shrink-0 font-mono text-xs"><b className="cr-diff-added">+{stats.additions}</b> <b className="cr-diff-deleted">−{stats.deletions}</b></span><span className="cr-review-chevron cr-review-chevron-end">{isExpanded ? "⌃" : "⌄"}</span></button><span id={`${reviewFileId(filePath)}-path`} role="tooltip" className="cr-review-file-tooltip">{fullPath}</span><button className="cr-review-open-file" type="button" title={`Open ${filePath} in Files`} aria-label={`Open ${filePath} in Files`} onClick={() => navigate.openThreadPanel({ actionId: "files", title: filePath.split("/").at(-1) ?? filePath, params: { path: filePath }, experimental_filePath: filePath })}><OpenFileIcon /></button></div>{isExpanded ? <div className="cr-review-patch"><ReviewCommentableDiff file={file} path={filePath} diffStyle={diffStyle} /></div> : null}</section>;
}

function filesFromTurnDiff(diff: string): TurnChangeFile[] {
  return diff
    .split(/(?=^diff --git )/mu)
    .filter((patch) => patch.startsWith("diff --git "))
    .map((patch) => {
      const header = patch.match(/^diff --git a\/(.+?) b\/(.+)$/mu);
      const toPath = patch.match(/^\+\+\+ b\/(.+)$/mu)?.[1];
      const fromPath = patch.match(/^--- a\/(.+)$/mu)?.[1];
      const path = toPath ?? fromPath ?? header?.[2] ?? header?.[1] ?? "Unknown file";
      let additions = 0;
      let deletions = 0;
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
        if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
      }
      return { path, additions, deletions, patch };
    });
}

function turnFileLabel(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function reviewFileLabel(path: string, previousPath: string | null = null): string {
  const current = turnFileLabel(path);
  return previousPath === null ? current : `${turnFileLabel(previousPath)} → ${current}`;
}

function TurnChangeCard({ message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [review, setReview] = useState<LastTurnReview | null>(null);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (message.turnId === null) return;
    let cancelled = false;
    let attempt = 0;
    const load = () => {
      void rpc.call("lastTurnReview", { threadId: message.threadId, turnId: message.turnId }).then((result) => {
        if (cancelled) return;
        setReview(result);
        if (result.state === "not_available" && attempt < 4) {
          attempt += 1;
          window.setTimeout(load, 500);
        }
      }).catch(() => { if (!cancelled) setReview(null); });
    };
    load();
    return () => { cancelled = true; };
  }, [message.threadId, message.turnId, rpc]);
  if (review?.state !== "ready" || review.additions + review.deletions === 0) return null;
  const files = filesFromTurnDiff(review.diff ?? "");
  return <section className="cr-turn-change-card" data-expanded={expanded ? "true" : "false"}><button className="cr-turn-change-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span className="cr-turn-change-icon" aria-hidden="true">◇</span><span className="min-w-0"><strong>Edited {files.length || 1} {files.length === 1 ? "file" : "files"}</strong><span><b className="cr-diff-added">+{review.additions}</b> <b className="cr-diff-deleted">−{review.deletions}</b></span></span><span className="cr-turn-change-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span></button><button className="cr-turn-review" type="button" onClick={() => navigate.openThreadPanel({ actionId: "review", title: "Review", params: { mode: "last_turn", turnId: review.turnId } })}>Review</button>{expanded ? <div className="cr-turn-change-files">{files.map((file) => <div className="cr-turn-change-file" key={file.path} title={file.path}><FileIcon name={file.path} /><span className="truncate">{turnFileLabel(file.path)}</span><span className="ml-auto shrink-0"><b className="cr-diff-added">+{file.additions}</b> <b className="cr-diff-deleted">−{file.deletions}</b></span></div>)}</div> : null}</section>;
}

function ReviewFileCard({ file, patch, isExpanded, onToggle, diffStyle }: { file: ReviewFile; patch: { patch: string; truncated: boolean } | null; isExpanded: boolean; onToggle: () => void; diffStyle: DiffStyle }) {
  const status = file.changeKind === "added" ? "A" : file.changeKind === "deleted" ? "D" : file.changeKind === "renamed" ? "R" : "M";
  const navigate = useBbNavigate();
  const fullPath = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  return <section id={reviewFileId(file.path)} className="cr-review-file"><div className="cr-review-file-header"><button className="cr-review-file-label flex min-w-0 flex-1 items-center gap-2 text-left" type="button" onClick={onToggle} aria-describedby={`${reviewFileId(file.path)}-path`}><span className="cr-review-chevron">{isExpanded ? "⌄" : "›"}</span><FileIcon name={file.path} /><span className="truncate font-mono text-xs">{reviewFileLabel(file.path, file.previousPath)}</span><span className={`cr-review-status cr-review-status-${file.changeKind}`}>{status}</span><span className="ml-auto shrink-0 font-mono text-xs"><b className="cr-diff-added">+{file.additions}</b> <b className="cr-diff-deleted">−{file.deletions}</b></span></button><span id={`${reviewFileId(file.path)}-path`} role="tooltip" className="cr-review-file-tooltip">{fullPath}</span><button className="cr-review-open-file" type="button" title={`Open ${file.path} in Files`} aria-label={`Open ${file.path} in Files`} onClick={() => navigate.openThreadPanel({ actionId: "files", title: file.path.split("/").at(-1) ?? file.path, params: { path: file.path }, experimental_filePath: file.path })}><OpenFileIcon /></button></div>{isExpanded ? <div className="cr-review-patch">{file.binary ? <p>Binary file changed.</p> : file.loadMode === "too_large" ? <p>This file is too large to display.</p> : patch === null ? <p>Loading diff…</p> : <>{patch.truncated ? <p className="cr-review-truncated">Diff is truncated.</p> : null}<ReviewPatch path={file.path} patch={patch.patch} diffStyle={diffStyle} /></>}</div> : null}</section>;
}

function reviewPatchForRenderer(path: string, patch: string): string | null {
  const hunkOffset = patch.search(/^@@ /mu);
  if (hunkOffset < 0) return null;
  const normalizedPath = path.replace(/^\/+|\/+$/gu, "");
  const hunks = patch.slice(hunkOffset).trimEnd();
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${hunks}\n`;
}

function ReviewPatch({ path, patch, diffStyle }: { path: string; patch: string; diffStyle: DiffStyle }) {
  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    try {
      const renderablePatch = reviewPatchForRenderer(path, patch);
      if (renderablePatch === null) return null;
      const parsed = parsePatchFiles(renderablePatch);
      return parsed.length === 1 && parsed[0]?.files.length === 1 ? parsed[0].files[0] ?? null : null;
    } catch { return null; }
  }, [path, patch]);
  if (fileDiff === null) return <p>Unable to parse this patch.</p>;
  return <ReviewCommentableDiff file={fileDiff} path={path} diffStyle={diffStyle} />;
}

function EmptyState({ message, onReload }: { message: string; onReload?: () => Promise<void> }) { return <main className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"><div><p>{message}</p>{onReload ? <button className="mt-3 text-xs text-foreground underline" onClick={() => void onReload()}>Try again</button> : null}</div></main>; }
export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: "files", title: "Files", icon: "FolderOpen", layout: "flush", component: ChangeReviewPanel });
  app.slots.threadPanelAction({ id: "review", title: "Review", icon: "FileDiff", layout: "flush", component: ReviewPanel });
  app.slots.messageDirective({ id: "change-review-last-turn", component: TurnChangeCard });
  app.slots.messageAction({
    id: "review-last-turn",
    title: "Review last turn",
    icon: "FileDiff",
    run: ({ message, openPanel }) => {
      if (message.role !== "assistant") return;
      openPanel({ actionId: "review", title: "Review", params: { mode: "last_turn" } });
    },
  });
});
