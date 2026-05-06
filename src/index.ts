import { Database } from "bun:sqlite"
import { constants as fsConstants } from "node:fs"
import { mkdirSync, realpathSync } from "node:fs"
import { access, copyFile, cp, mkdir, rm, stat, symlink } from "node:fs/promises"
import * as crypto from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import * as fsSync from "node:fs"
import { type Plugin, tool } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { createOpencodeClient } from "@opencode-ai/sdk"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

// =============================================================================
// KDCO PRIMITIVES (inlined)
// =============================================================================

const SHELL_FORBIDDEN_CHARS = /[\x00]/

function assertShellSafe(value: string, context: string): void {
  if (SHELL_FORBIDDEN_CHARS.test(value)) {
    throw new Error(
      `${context} contains null bytes which cannot be safely escaped for shell execution`,
    )
  }
}

function escapeBash(str: string): string {
  assertShellSafe(str, "Bash argument")
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!")
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
}

function escapeAppleScript(str: string): string {
  assertShellSafe(str, "AppleScript argument")
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
}

function escapeBatch(str: string): string {
  assertShellSafe(str, "Batch argument")
  return str
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/&/g, "^&")
    .replace(/</g, "^<")
    .replace(/>/g, "^>")
    .replace(/\|/g, "^|")
}

function getTempDir(): string {
  return realpathSync.native(os.tmpdir())
}

function isInsideTmux(): boolean {
  return !!process.env.TMUX
}

class Mutex {
  private locked = false
  private queue: (() => void)[] = []

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

class TimeoutError extends Error {
  readonly name = "TimeoutError" as const
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number) {
    super(message)
    this.timeoutMs = timeoutMs
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out",
): Promise<T> {
  if (typeof ms !== "number" || ms < 0) {
    throw new Error(`withTimeout: timeout must be a non-negative number, got ${ms}`)
  }
  if (ms === 0) {
    throw new TimeoutError(message, ms)
  }
  let timeoutId: Timer
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TimeoutError(message, ms))
      }, ms)
    }),
  ])
}

function logWarn(
  client: OpencodeClient | undefined,
  service: string,
  message: string,
): void {
  if (!client) {
    console.warn(`[${service}] ${message}`)
    return
  }
  client.app
    .log({
      body: { service, level: "warn", message },
    })
    .catch(() => {})
}

function hashPath(projectRoot: string): string {
  const hash = crypto.createHash("sha256").update(projectRoot).digest("hex")
  return hash.slice(0, 16)
}

async function getProjectId(projectRoot: string, client?: OpencodeClient): Promise<string> {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("getProjectId: projectRoot is required and must be a string")
  }

  const gitPath = path.join(projectRoot, ".git")
  const gitStat = await stat(gitPath).catch(() => null)

  if (!gitStat) {
    logWarn(client, "project-id", `No .git found at ${projectRoot}, using path hash`)
    return hashPath(projectRoot)
  }

  let gitDir = gitPath

  if (gitStat.isFile()) {
    const content = await Bun.file(gitPath).text()
    const match = content.match(/^gitdir:\s*(.+)$/m)

    if (!match) {
      throw new Error(`getProjectId: .git file exists but has invalid format at ${gitPath}`)
    }

    const gitdirPath = match[1].trim()
    const resolvedGitdir = path.resolve(projectRoot, gitdirPath)

    const commondirPath = path.join(resolvedGitdir, "commondir")
    const commondirFile = Bun.file(commondirPath)

    if (await commondirFile.exists()) {
      const commondirContent = (await commondirFile.text()).trim()
      gitDir = path.resolve(resolvedGitdir, commondirContent)
    } else {
      gitDir = path.resolve(resolvedGitdir, "../..")
    }

    const gitDirStat = await stat(gitDir).catch(() => null)
    if (!gitDirStat?.isDirectory()) {
      throw new Error(`getProjectId: Resolved gitdir ${gitDir} is not a directory`)
    }
  }

  const cacheFile = path.join(gitDir, "opencode")
  const cache = Bun.file(cacheFile)

  if (await cache.exists()) {
    const cached = (await cache.text()).trim()
    if (/^[a-f0-9]{40}$/i.test(cached) || /^[a-f0-9]{16}$/i.test(cached)) {
      return cached
    }
    logWarn(client, "project-id", `Invalid cache content at ${cacheFile}, regenerating`)
  }

  try {
    const proc = Bun.spawn(["git", "rev-list", "--max-parents=0", "--all"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    })

    const timeoutMs = 5000
    const exitCode = await withTimeout(proc.exited, timeoutMs, `git rev-list timed out`).catch(
      (e) => {
        if (e instanceof TimeoutError) {
          proc.kill()
        }
        return 1
      },
    )

    if (exitCode === 0) {
      const output = await new Response(proc.stdout).text()
      const roots = output
        .split("\n")
        .filter(Boolean)
        .map((x) => x.trim())
        .sort()

      if (roots.length > 0 && /^[a-f0-9]{40}$/i.test(roots[0])) {
        const projectId = roots[0]
        try {
          await Bun.write(cacheFile, projectId)
        } catch (e) {
          logWarn(client, "project-id", `Failed to cache project ID: ${e}`)
        }
        return projectId
      }
    } else {
      const stderr = await new Response(proc.stderr).text()
      logWarn(client, "project-id", `git rev-list failed (${exitCode}): ${stderr.trim()}`)
    }
  } catch (error) {
    logWarn(client, "project-id", `git command failed: ${error}`)
  }

  return hashPath(projectRoot)
}

// =============================================================================
// LAUNCH CONTEXT (inlined)
// =============================================================================

type ActiveLaunchContext =
  | { mode: "plain" }
  | { mode: "ocx"; ocxBin: string; profile: string }

type PersistedLaunchMetadata =
  | { mode: "plain" }
  | { mode: "ocx"; ocxBin: string; profile: string }

interface PersistedLaunchMetadataInput {
  launchMode?: string | null
  ocxBin?: string | null
  profile?: string | null
}

const ocxContextMarkerSchema = z.literal("1")

function normalizeOptionalNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function requireNonEmptyField(
  value: string | undefined,
  fieldName: string,
  source: string,
): string {
  if (value) {
    return value
  }
  throw new Error(`${source} requires ${fieldName} to be set to a non-empty value`)
}

function parseActiveLaunchContext(
  env: Record<string, string | undefined> = process.env,
): ActiveLaunchContext {
  const markerResult = ocxContextMarkerSchema.safeParse(env.OCX_CONTEXT?.trim())
  if (!markerResult.success) {
    return { mode: "plain" }
  }

  const ocxBin = requireNonEmptyField(
    normalizeOptionalNonEmpty(env.OCX_BIN),
    "OCX_BIN",
    "Invalid OCX launch context (OCX_CONTEXT=1)",
  )
  const profile = requireNonEmptyField(
    normalizeOptionalNonEmpty(env.OCX_PROFILE),
    "OCX_PROFILE",
    "Invalid OCX launch context (OCX_CONTEXT=1)",
  )

  return { mode: "ocx", ocxBin, profile }
}

function parsePersistedLaunchMetadata(
  input: PersistedLaunchMetadataInput,
): PersistedLaunchMetadata {
  const launchMode = normalizeOptionalNonEmpty(input.launchMode)

  if (!launchMode) {
    return { mode: "plain" }
  }

  if (launchMode === "plain") {
    return { mode: "plain" }
  }

  if (launchMode !== "ocx") {
    throw new Error(`Invalid persisted launch metadata: unsupported launchMode "${launchMode}"`)
  }

  const ocxBin = requireNonEmptyField(
    normalizeOptionalNonEmpty(input.ocxBin),
    "ocxBin",
    "Invalid persisted launch metadata (launchMode=ocx)",
  )
  const profile = requireNonEmptyField(
    normalizeOptionalNonEmpty(input.profile),
    "profile",
    "Invalid persisted launch metadata (launchMode=ocx)",
  )

  return { mode: "ocx", ocxBin, profile }
}

function buildSessionLaunchArgv(
  sessionID: string,
  launchMetadata: ActiveLaunchContext | PersistedLaunchMetadata,
): string[] {
  const normalizedSessionID = normalizeOptionalNonEmpty(sessionID)
  if (!normalizedSessionID) {
    throw new Error("Session id is required to build launch argv")
  }

  if (launchMetadata.mode === "plain") {
    return ["opencode", "--session", normalizedSessionID]
  }

  return [
    launchMetadata.ocxBin,
    "opencode",
    "-p",
    launchMetadata.profile,
    "--session",
    normalizedSessionID,
  ]
}

function toPersistedLaunchMetadata(
  launchContext: ActiveLaunchContext,
): PersistedLaunchMetadata {
  if (launchContext.mode === "plain") {
    return { mode: "plain" }
  }
  return { mode: "ocx", ocxBin: launchContext.ocxBin, profile: launchContext.profile }
}

function serializePersistedLaunchMetadata(metadata: PersistedLaunchMetadata): {
  launchMode: "plain" | "ocx"
  profile: string | null
  ocxBin: string | null
} {
  if (metadata.mode === "plain") {
    return { launchMode: "plain", profile: null, ocxBin: null }
  }
  return { launchMode: "ocx", profile: metadata.profile, ocxBin: metadata.ocxBin }
}

// =============================================================================
// TYPES & SCHEMAS
// =============================================================================

interface Logger {
  debug: (msg: string) => void
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

interface OkResult<T> {
  readonly ok: true
  readonly value: T
}
interface ErrResult<E> {
  readonly ok: false
  readonly error: E
}
type Result<T, E> = OkResult<T> | ErrResult<E>

const Result = {
  ok: <T>(value: T): OkResult<T> => ({ ok: true, value }),
  err: <E>(error: E): ErrResult<E> => ({ ok: false, error }),
}

interface TerminalResult {
  success: boolean
  error?: string
}

interface Session {
  id: string
  branch: string
  path: string
  createdAt: string
  launchMode: "plain" | "ocx"
  profile: string | null
  ocxBin: string | null
}

type SessionInput = Omit<Session, "launchMode" | "profile" | "ocxBin"> & {
  launchMode?: "plain" | "ocx"
  profile?: string | null
  ocxBin?: string | null
}

interface PendingDelete {
  branch: string
  path: string
}

type LaunchMode = "tmux-window" | "tmux-session" | "terminal" | "vscode"

function isValidBranchName(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return false
  }
  if (/[~^:?*[\]\\;&|`$()]/.test(name)) return false
  return true
}

const branchNameSchema = z
  .string()
  .min(1, "Branch name cannot be empty")
  .refine((name) => !name.startsWith("-"), {
    message: "Branch name cannot start with '-' (prevents option injection)",
  })
  .refine((name) => !name.startsWith("/") && !name.endsWith("/"), {
    message: "Branch name cannot start or end with '/'",
  })
  .refine((name) => !name.includes("//"), {
    message: "Branch name cannot contain '//'",
  })
  .refine((name) => !name.includes("@{"), {
    message: "Branch name cannot contain '@{' (git reflog syntax)",
  })
  .refine((name) => !name.includes(".."), {
    message: "Branch name cannot contain '..'",
  })
  .refine((name) => !/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name), {
    message: "Branch name contains invalid characters",
  })
  .max(255, "Branch name too long")
  .refine((name) => isValidBranchName(name), "Contains invalid git ref characters")
  .refine((name) => !name.startsWith(".") && !name.endsWith("."), "Cannot start or end with dot")
  .refine((name) => !name.endsWith(".lock"), "Cannot end with .lock")

const launchModeSchema = z.enum(["tmux-window", "tmux-session", "terminal", "vscode"]).default("tmux-window")

const worktreeConfigSchema = z.object({
  worktreePath: z.string().optional(),
  launchMode: launchModeSchema.optional(),
  sync: z
    .object({
      copyFiles: z.array(z.string()).default([]),
      symlinkDirs: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default(() => ({ copyFiles: [], symlinkDirs: [], exclude: [] })),
  hooks: z
    .object({
      postCreate: z.array(z.string()).default([]),
      preDelete: z.array(z.string()).default([]),
    })
    .default(() => ({ postCreate: [], preDelete: [] })),
})

type WorktreeConfig = z.infer<typeof worktreeConfigSchema>

const sessionSchema = z.object({
  id: z.string().min(1),
  branch: z.string().min(1),
  path: z.string().min(1),
  createdAt: z.string().min(1),
  launchMode: z.enum(["plain", "ocx"]).optional(),
  profile: z.string().nullable().optional(),
  ocxBin: z.string().nullable().optional(),
})

const pendingDeleteSchema = z.object({
  branch: z.string().min(1),
  path: z.string().min(1),
})

// =============================================================================
// ERROR TYPES
// =============================================================================

class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly cause?: unknown,
  ) {
    super(`${operation}: ${message}`)
    this.name = "WorktreeError"
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DB_MAX_RETRIES = 3
const DB_RETRY_DELAY_MS = 100
const MAX_SESSION_CHAIN_DEPTH = 10
const STABILIZATION_DELAY_MS = 150

// =============================================================================
// LAUNCH CONTEXT VALIDATION
// =============================================================================

type ResolveExecutable = (command: string) => string | null | undefined

function isPathLikeCommand(command: string): boolean {
  return command.includes("/") || command.includes("\\")
}

function resolveStableLaunchBinaryPath(
  ocxBin: string,
  baseDirectory: string,
  resolveExecutable: ResolveExecutable,
): Result<string, string> {
  if (isPathLikeCommand(ocxBin)) {
    const resolvedPath = path.isAbsolute(ocxBin) ? ocxBin : path.resolve(baseDirectory, ocxBin)
    return Result.ok(resolvedPath)
  }

  const resolvedFromPath = resolveExecutable(ocxBin)
  if (!resolvedFromPath) {
    return Result.err(`Configured OCX binary "${ocxBin}" is not available in PATH.`)
  }

  const resolvedPath = path.isAbsolute(resolvedFromPath)
    ? resolvedFromPath
    : path.resolve(baseDirectory, resolvedFromPath)

  return Result.ok(resolvedPath)
}

async function pathPointsToLaunchableBinary(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath)
    if (stats.isDirectory()) {
      return false
    }
    await access(absolutePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function ensureLaunchContextExecutable(
  launchContext: ActiveLaunchContext,
  baseDirectory: string,
): Promise<ActiveLaunchContext> {
  if (launchContext.mode === "plain") {
    return launchContext
  }

  const { ocxBin, profile } = launchContext
  const resolveExecutable = (command: string) => Bun.which(command)
  const resolvedPathResult = resolveStableLaunchBinaryPath(ocxBin, baseDirectory, resolveExecutable)
  if (!resolvedPathResult.ok) {
    throw new WorktreeError(
      `${resolvedPathResult.error} Repair the parent OCX profile (${profile}) and recreate this worktree session.`,
      "launch",
    )
  }

  const resolvedPath = resolvedPathResult.value
  const isLaunchable = await pathPointsToLaunchableBinary(resolvedPath)
  if (!isLaunchable) {
    throw new WorktreeError(
      `Configured OCX binary "${ocxBin}" resolved to "${resolvedPath}" but is missing or stale. Repair the parent OCX profile (${profile}) and recreate this worktree session.`,
      "launch",
    )
  }

  return { mode: "ocx", ocxBin: resolvedPath, profile }
}

async function validateOcxProfileAvailability(
  ocxBin: string,
  profile: string,
): Promise<Result<void, string>> {
  try {
    const proc = Bun.spawn([ocxBin, "profile", "show", profile, "--global", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    if (exitCode === 0) {
      return Result.ok(undefined)
    }

    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`
    return Result.err(detail)
  } catch (error) {
    return Result.err(error instanceof Error ? error.message : String(error))
  }
}

async function ensureLaunchContextProfile(
  launchContext: ActiveLaunchContext,
): Promise<void> {
  if (launchContext.mode === "plain") {
    return
  }

  const validationResult = await validateOcxProfileAvailability(
    launchContext.ocxBin,
    launchContext.profile,
  )
  if (validationResult.ok) {
    return
  }

  throw new WorktreeError(
    `Configured OCX profile "${launchContext.profile}" is missing or stale. ${validationResult.error} Repair the parent OCX profile and recreate this worktree session.`,
    "launch",
  )
}

// =============================================================================
// FILE HELPERS
// =============================================================================

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      return false
    }
    throw e
  }
}

async function copyIfExists(src: string, dest: string): Promise<boolean> {
  if (!(await pathExists(src))) return false
  await copyFile(src, dest)
  return true
}

async function copyDirIfExists(src: string, dest: string): Promise<boolean> {
  if (!(await pathExists(src))) return false
  await cp(src, dest, { recursive: true })
  return true
}

// =============================================================================
// SQLITE STATE (inlined)
// =============================================================================

function getWorktreeBaseDirectory(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "worktree")
}

async function getWorktreePath(
  projectRoot: string,
  branch: string,
  basePath?: string,
): Promise<string> {
  if (!branch || typeof branch !== "string") {
    throw new Error("branch is required")
  }
  const projectId = await getProjectId(projectRoot)
  return path.join(basePath ?? getWorktreeBaseDirectory(), projectId, branch)
}

function getDbDirectory(): string {
  const home = os.homedir()
  return path.join(home, ".local", "share", "opencode", "plugins", "worktree")
}

async function getDbPath(projectRoot: string): Promise<string> {
  const projectId = await getProjectId(projectRoot)
  return path.join(getDbDirectory(), `${projectId}.sqlite`)
}

function ensureSessionLaunchMetadataColumns(db: Database): void {
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: string }>
  const sessionColumns = new Set(tableInfo.map((column) => column.name).filter(Boolean))

  if (!sessionColumns.has("launch_mode")) {
    addSessionColumn(db, "launch_mode", "ALTER TABLE sessions ADD COLUMN launch_mode TEXT")
  }
  if (!sessionColumns.has("profile")) {
    addSessionColumn(db, "profile", "ALTER TABLE sessions ADD COLUMN profile TEXT")
  }
  if (!sessionColumns.has("ocx_bin")) {
    addSessionColumn(db, "ocx_bin", "ALTER TABLE sessions ADD COLUMN ocx_bin TEXT")
  }
}

function addSessionColumn(db: Database, columnName: string, sql: string): void {
  try {
    db.exec(sql)
  } catch (error) {
    if (isDuplicateColumnError(error, columnName)) {
      return
    }
    throw error
  }
}

function isDuplicateColumnError(error: unknown, columnName: string): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const normalizedMessage = error.message.toLowerCase()
  return (
    normalizedMessage.includes("duplicate column name") &&
    normalizedMessage.includes(columnName.toLowerCase())
  )
}

function normalizeSessionRow(row: Record<string, string | null>): Session {
  const launchMetadata = parsePersistedLaunchMetadata({
    launchMode: row.launchMode,
    profile: row.profile,
    ocxBin: row.ocxBin,
  })
  const serialized = serializePersistedLaunchMetadata(launchMetadata)

  return {
    id: String(row.id),
    branch: String(row.branch),
    path: String(row.path),
    createdAt: String(row.createdAt),
    launchMode: serialized.launchMode,
    profile: serialized.profile,
    ocxBin: serialized.ocxBin,
  }
}

async function initStateDb(projectRoot: string): Promise<Database> {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("initStateDb requires a valid project root path")
  }

  const dbPath = await getDbPath(projectRoot)
  const dbDir = path.dirname(dbPath)

  mkdirSync(dbDir, { recursive: true })

  const db = new Database(dbPath)

  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA busy_timeout=5000")

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      launch_mode TEXT,
      profile TEXT,
      ocx_bin TEXT
    )
  `)

  ensureSessionLaunchMetadataColumns(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_operations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      type TEXT NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      session_id TEXT
    )
  `)

  return db
}

function addSession(db: Database, session: SessionInput): void {
  const parsed = sessionSchema.parse(session)
  const launchMetadata = parsePersistedLaunchMetadata({
    launchMode: parsed.launchMode,
    profile: parsed.profile,
    ocxBin: parsed.ocxBin,
  })
  const serializedLaunchMetadata = serializePersistedLaunchMetadata(launchMetadata)

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, branch, path, created_at, launch_mode, profile, ocx_bin)
    VALUES ($id, $branch, $path, $createdAt, $launchMode, $profile, $ocxBin)
  `)

  stmt.run({
    $id: parsed.id,
    $branch: parsed.branch,
    $path: parsed.path,
    $createdAt: parsed.createdAt,
    $launchMode: serializedLaunchMetadata.launchMode,
    $profile: serializedLaunchMetadata.profile,
    $ocxBin: serializedLaunchMetadata.ocxBin,
  })
}

function getSession(db: Database, sessionId: string): Session | null {
  if (!sessionId) return null

  const stmt = db.prepare(`
    SELECT id, branch, path, created_at as createdAt, launch_mode as launchMode, profile, ocx_bin as ocxBin
    FROM sessions
    WHERE id = $id
  `)

  const row = stmt.get({ $id: sessionId }) as Record<string, string | null> | null
  if (!row) return null

  return normalizeSessionRow(row)
}

function removeSession(db: Database, branch: string): void {
  if (!branch) return
  const stmt = db.prepare(`DELETE FROM sessions WHERE branch = $branch`)
  stmt.run({ $branch: branch })
}

function getAllSessions(db: Database): Session[] {
  const stmt = db.prepare(`
    SELECT id, branch, path, created_at as createdAt, launch_mode as launchMode, profile, ocx_bin as ocxBin
    FROM sessions
    ORDER BY created_at ASC
  `)
  const rows = stmt.all() as Array<Record<string, string | null>>
  return rows.map((row) => normalizeSessionRow(row))
}

function setPendingDelete(db: Database, del: PendingDelete, client?: OpencodeClient): void {
  const parsed = pendingDeleteSchema.parse(del)

  const existingDelete = getPendingDelete(db)
  const existingSpawn = getPendingSpawn(db)

  if (existingDelete) {
    logWarn(
      client,
      "worktree",
      `Replacing pending delete: "${existingDelete.branch}" → "${parsed.branch}"`,
    )
  } else if (existingSpawn) {
    logWarn(
      client,
      "worktree",
      `Pending delete replacing pending spawn for: "${existingSpawn.branch}"`,
    )
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO pending_operations (id, type, branch, path, session_id)
    VALUES (1, 'delete', $branch, $path, NULL)
  `)

  stmt.run({
    $branch: parsed.branch,
    $path: parsed.path,
  })
}

function getPendingDelete(db: Database): PendingDelete | null {
  const stmt = db.prepare(`
    SELECT type, branch, path
    FROM pending_operations
    WHERE id = 1 AND type = 'delete'
  `)

  const row = stmt.get() as Record<string, string> | null
  if (!row) return null

  return { branch: row.branch, path: row.path }
}

function clearPendingDelete(db: Database): void {
  const stmt = db.prepare(`DELETE FROM pending_operations WHERE id = 1 AND type = 'delete'`)
  stmt.run()
}

function getPendingSpawn(db: Database): { branch: string; path: string; sessionId: string } | null {
  const stmt = db.prepare(`
    SELECT type, branch, path, session_id as sessionId
    FROM pending_operations
    WHERE id = 1 AND type = 'spawn'
  `)

  const row = stmt.get() as Record<string, string> | null
  if (!row) return null

  return { branch: row.branch, path: row.path, sessionId: row.sessionId }
}

// =============================================================================
// GIT MODULE
// =============================================================================

async function git(args: string[], cwd: string): Promise<Result<string, string>> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      return Result.err(stderr.trim() || `git ${args[0]} failed`)
    }
    return Result.ok(stdout.trim())
  } catch (error) {
    return Result.err(error instanceof Error ? error.message : String(error))
  }
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", branch], cwd)
  return result.ok
}

async function createWorktree(
  repoRoot: string,
  branch: string,
  baseBranch?: string,
  basePath?: string,
): Promise<Result<string, string>> {
  const worktreePath = await getWorktreePath(repoRoot, branch, basePath)
  await mkdir(path.dirname(worktreePath), { recursive: true })

  const exists = await branchExists(repoRoot, branch)

  if (exists) {
    const result = await git(["worktree", "add", worktreePath, branch], repoRoot)
    return result.ok ? Result.ok(worktreePath) : result
  } else {
    const base = baseBranch ?? "HEAD"
    const result = await git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot)
    return result.ok ? Result.ok(worktreePath) : result
  }
}

async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<Result<void, string>> {
  const result = await git(["worktree", "remove", "--force", worktreePath], repoRoot)
  return result.ok ? Result.ok(undefined) : Result.err(result.error)
}

// =============================================================================
// TERMINAL LAUNCH MODES
// =============================================================================

const tmuxMutex = new Mutex()

function buildBashCommandFromArgv(argv?: string[]): string | undefined {
  if (!argv || argv.length === 0) return undefined
  return argv.map((arg) => `"${escapeBash(arg)}"`).join(" ")
}

function wrapWithSelfCleanup(script: string): string {
  return `#!/bin/bash
trap 'rm -f "$0"' EXIT INT TERM
${script}`
}

async function openTmuxWindow(options: {
  sessionName?: string
  windowName: string
  cwd: string
  argv?: string[]
}): Promise<TerminalResult> {
  const { sessionName, windowName, cwd, argv } = options
  const command = buildBashCommandFromArgv(argv)

  return tmuxMutex.runExclusive(async () => {
    try {
      const tmuxArgs = ["new-window", "-n", windowName, "-c", cwd, "-P", "-F", "#{pane_id}"]

      if (sessionName) {
        tmuxArgs.splice(1, 0, "-t", sessionName)
      }

      if (command) {
        const scriptPath = path.join(getTempDir(), `worktree-${Bun.randomUUIDv7()}.sh`)
        const escapedCwd = escapeBash(cwd)
        const scriptContent = wrapWithSelfCleanup(
          `cd "${escapedCwd}" || exit 1\n${command}\nexec $SHELL`,
        )
        await Bun.write(scriptPath, scriptContent)
        Bun.spawnSync(["chmod", "+x", scriptPath])
        tmuxArgs.push("--", "bash", scriptPath)
      }

      const createResult = Bun.spawnSync(["tmux", ...tmuxArgs])

      if (createResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to create tmux window: ${createResult.stderr.toString()}`,
        }
      }

      await Bun.sleep(STABILIZATION_DELAY_MS)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

async function openTmuxSession(options: {
  sessionName: string
  cwd: string
  argv?: string[]
}): Promise<TerminalResult> {
  const { sessionName, cwd, argv } = options
  const command = buildBashCommandFromArgv(argv)

  return tmuxMutex.runExclusive(async () => {
    try {
      const newSessionArgs = ["new-session", "-d", "-s", sessionName, "-c", cwd]

      if (command) {
        const scriptPath = path.join(getTempDir(), `worktree-${Bun.randomUUIDv7()}.sh`)
        const escapedCwd = escapeBash(cwd)
        const scriptContent = wrapWithSelfCleanup(
          `cd "${escapedCwd}" || exit 1\n${command}\nexec $SHELL`,
        )
        await Bun.write(scriptPath, scriptContent)
        Bun.spawnSync(["chmod", "+x", scriptPath])
        newSessionArgs.push("--", "bash", scriptPath)
      }

      const newResult = Bun.spawnSync(["tmux", ...newSessionArgs])
      if (newResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to create tmux session: ${newResult.stderr.toString()}`,
        }
      }

      const switchResult = Bun.spawnSync(["tmux", "switch-client", "-t", sessionName])
      if (switchResult.exitCode !== 0) {
        return {
          success: false,
          error: `Session created but switch-client failed: ${switchResult.stderr.toString()}`,
        }
      }

      await Bun.sleep(STABILIZATION_DELAY_MS)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

async function openDesktopTerminal(cwd: string, argv?: string[]): Promise<TerminalResult> {
  if (!cwd) {
    return { success: false, error: "Working directory is required" }
  }

  const escapedCwd = escapeBash(cwd)
  const command = buildBashCommandFromArgv(argv)
  const scriptContent = wrapWithSelfCleanup(
    command ? `cd "${escapedCwd}" && ${command}\nexec bash` : `cd "${escapedCwd}"\nexec bash`,
  )

  let scriptPath: string | null = null

  const cleanupFile = async (filePath: string | null): Promise<void> => {
    if (!filePath) return
    try { await rm(filePath) } catch {}
  }

  const ensureScriptPath = async (): Promise<string> => {
    if (scriptPath) return scriptPath
    scriptPath = path.join(
      getTempDir(),
      `worktree-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
    )
    await Bun.write(scriptPath, scriptContent)
    const { chmod } = await import("node:fs/promises")
    await chmod(scriptPath, 0o755)
    return scriptPath
  }

  try {
    const tryTerminal = async (
      name: string,
      args: string[],
    ): Promise<{ tried: boolean; success: boolean }> => {
      const check = Bun.spawnSync(["which", name])
      if (check.exitCode !== 0) {
        return { tried: false, success: false }
      }
      try {
        const proc = Bun.spawn(args, {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        })
        proc.unref()
        return { tried: true, success: true }
      } catch {
        return { tried: true, success: false }
      }
    }

    const launchScriptPath = await ensureScriptPath()

    const terminals: Array<{ name: string; args: string[] }> = [
      { name: "kitty", args: ["kitty", "--directory", cwd, "-e", "bash", launchScriptPath] },
      { name: "alacritty", args: ["alacritty", "--working-directory", cwd, "-e", "bash", launchScriptPath] },
      { name: "ghostty", args: ["ghostty", "-e", "bash", launchScriptPath] },
      { name: "gnome-terminal", args: ["gnome-terminal", "--working-directory", cwd, "--", "bash", launchScriptPath] },
      { name: "konsole", args: ["konsole", "--workdir", cwd, "-e", "bash", launchScriptPath] },
      { name: "xterm", args: ["xterm", "-e", "bash", launchScriptPath] },
    ]

    for (const { name, args } of terminals) {
      const result = await tryTerminal(name, args)
      if (result.success) return { success: true }
    }

    await cleanupFile(scriptPath)
    scriptPath = null
    return { success: false, error: "No terminal emulator found" }
  } catch (error) {
    await cleanupFile(scriptPath)
    return {
      success: false,
      error: `Failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function openVSCode(cwd: string): Promise<TerminalResult> {
  try {
    const proc = Bun.spawn(["code", cwd], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    })
    proc.unref()
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: `Failed to open VS Code: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function launchWorktreeTerminal(
  launchMode: LaunchMode,
  worktreePath: string,
  argv: string[],
  branch: string,
): Promise<TerminalResult> {
  switch (launchMode) {
    case "tmux-window":
      return openTmuxWindow({
        windowName: branch,
        cwd: worktreePath,
        argv,
      })

    case "tmux-session":
      return openTmuxSession({
        sessionName: branch,
        cwd: worktreePath,
        argv,
      })

    case "terminal":
      return openDesktopTerminal(worktreePath, argv)

    case "vscode":
      return openVSCode(worktreePath)

    default:
      return { success: false, error: `Unknown launch mode: ${launchMode}` }
  }
}

// =============================================================================
// FILE SYNC MODULE
// =============================================================================

function isPathSafe(filePath: string, baseDir: string, log: Logger): boolean {
  if (path.isAbsolute(filePath)) {
    log.warn(`[worktree] Rejected absolute path: ${filePath}`)
    return false
  }
  if (filePath.includes("..")) {
    log.warn(`[worktree] Rejected path traversal: ${filePath}`)
    return false
  }
  const resolved = path.resolve(baseDir, filePath)
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    log.warn(`[worktree] Path escapes base directory: ${filePath}`)
    return false
  }
  return true
}

async function copyFiles(
  sourceDir: string,
  targetDir: string,
  files: string[],
  log: Logger,
): Promise<void> {
  for (const file of files) {
    if (!isPathSafe(file, sourceDir, log)) continue

    const sourcePath = path.join(sourceDir, file)
    const targetPath = path.join(targetDir, file)

    try {
      const sourceFile = Bun.file(sourcePath)
      if (!(await sourceFile.exists())) {
        log.debug(`[worktree] Skipping missing file: ${file}`)
        continue
      }

      const targetFileDir = path.dirname(targetPath)
      await mkdir(targetFileDir, { recursive: true })

      await Bun.write(targetPath, sourceFile)
      log.info(`[worktree] Copied: ${file}`)
    } catch (error) {
      const isNotFound =
        error instanceof Error &&
        (error.message.includes("ENOENT") || error.message.includes("no such file"))
      if (isNotFound) {
        log.debug(`[worktree] Skipping missing: ${file}`)
      } else {
        log.warn(`[worktree] Failed to copy ${file}: ${error}`)
      }
    }
  }
}

async function symlinkDirs(
  sourceDir: string,
  targetDir: string,
  dirs: string[],
  log: Logger,
): Promise<void> {
  for (const dir of dirs) {
    if (!isPathSafe(dir, sourceDir, log)) continue

    const sourcePath = path.join(sourceDir, dir)
    const targetPath = path.join(targetDir, dir)

    try {
      const fileStat = await stat(sourcePath).catch(() => null)
      if (!fileStat || !fileStat.isDirectory()) {
        log.debug(`[worktree] Skipping missing directory: ${dir}`)
        continue
      }

      const targetParentDir = path.dirname(targetPath)
      await mkdir(targetParentDir, { recursive: true })

      await rm(targetPath, { recursive: true, force: true })
      await symlink(sourcePath, targetPath, "dir")
      log.info(`[worktree] Symlinked: ${dir}`)
    } catch (error) {
      log.warn(`[worktree] Failed to symlink ${dir}: ${error}`)
    }
  }
}

async function runHooks(cwd: string, commands: string[], log: Logger): Promise<void> {
  for (const command of commands) {
    log.info(`[worktree] Running hook: ${command}`)
    try {
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd,
        stdout: "inherit",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.toString() || ""
        log.warn(
          `[worktree] Hook failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`,
        )
      }
    } catch (error) {
      log.warn(`[worktree] Hook error: ${error}`)
    }
  }
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

function resolveHomePath(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

async function loadWorktreeConfig(directory: string, log: Logger): Promise<WorktreeConfig> {
  const configPath = path.join(directory, ".opencode", "worktree.jsonc")

  try {
    const file = Bun.file(configPath)
    if (!(await file.exists())) {
      const defaultConfig = `{
  "$schema": "https://registry.kdco.dev/schemas/worktree.json",

  // Worktree plugin configuration

  // Custom base path for worktree storage (supports ~)
  // Default: ~/.local/share/opencode/worktree
  // "worktreePath": "~/my-worktrees",

  // Launch mode: "tmux-window" | "tmux-session" | "terminal" | "vscode"
  // Default: "tmux-window"
  // "launchMode": "tmux-window",

  "sync": {
    // Files to copy from main worktree to new worktrees
    "copyFiles": [],
    // Directories to symlink (saves disk space)
    "symlinkDirs": [],
    // Patterns to exclude from copying
    "exclude": []
  },

  "hooks": {
    // Commands to run after worktree creation
    "postCreate": [],
    // Commands to run before worktree deletion
    "preDelete": []
  }
}
`
      await mkdir(path.join(directory, ".opencode"), { recursive: true })
      await Bun.write(configPath, defaultConfig)
      log.info(`[worktree] Created default config: ${configPath}`)
      return worktreeConfigSchema.parse({})
    }

    const content = await file.text()
    const parsed = parseJsonc(content)
    if (parsed === undefined) {
      log.error(`[worktree] Invalid worktree.jsonc syntax`)
      return worktreeConfigSchema.parse({})
    }
    const config = worktreeConfigSchema.parse(parsed)
    if (config.worktreePath) {
      config.worktreePath = resolveHomePath(config.worktreePath)
    }
    return config
  } catch (error) {
    log.warn(`[worktree] Failed to load config: ${error}`)
    return worktreeConfigSchema.parse({})
  }
}

// =============================================================================
// SESSION FORKING
// =============================================================================

interface ForkResult {
  forkedSession: { id: string }
  rootSessionId: string
  planCopied: boolean
  delegationsCopied: boolean
}

async function forkWithContext(
  client: OpencodeClient,
  sessionId: string,
  projectId: string,
  getRootSessionIdFn: (sessionId: string) => Promise<string>,
): Promise<ForkResult> {
  if (!client) throw new WorktreeError("client is required", "forkWithContext")
  if (!sessionId) throw new WorktreeError("sessionId is required", "forkWithContext")
  if (!projectId) throw new WorktreeError("projectId is required", "forkWithContext")

  let rootSessionId: string
  try {
    rootSessionId = await getRootSessionIdFn(sessionId)
  } catch (e) {
    throw new WorktreeError("Failed to get root session ID", "forkWithContext", e)
  }

  const forkedSessionResponse = await client.session.fork({
    path: { id: sessionId },
    body: {},
  })
  const forkedSession = forkedSessionResponse.data
  if (!forkedSession?.id) {
    throw new WorktreeError("Failed to fork session: no session data returned", "forkWithContext")
  }

  let planCopied = false
  let delegationsCopied = false

  try {
    const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
    const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")

    const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
    const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)

    await mkdir(destWorkspaceDir, { recursive: true })
    await mkdir(destDelegationsDir, { recursive: true })

    const srcPlan = path.join(workspaceBase, projectId, rootSessionId, "plan.md")
    const destPlan = path.join(destWorkspaceDir, "plan.md")
    planCopied = await copyIfExists(srcPlan, destPlan)

    const srcDelegations = path.join(delegationsBase, projectId, rootSessionId)
    delegationsCopied = await copyDirIfExists(srcDelegations, destDelegationsDir)
  } catch (error) {
    client.app
      .log({
        body: {
          service: "worktree",
          level: "error",
          message: `forkWithContext: Copy failed, cleaning up forked session: ${error}`,
        },
      })
      .catch(() => {})

    const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
    const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")
    const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
    const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)

    await rm(destWorkspaceDir, { recursive: true, force: true }).catch((e) => {
      client.app
        .log({
          body: {
            service: "worktree",
            level: "error",
            message: `forkWithContext: Failed to clean up workspace dir ${destWorkspaceDir}: ${e}`,
          },
        })
        .catch(() => {})
    })
    await rm(destDelegationsDir, { recursive: true, force: true }).catch((e) => {
      client.app
        .log({
          body: {
            service: "worktree",
            level: "error",
            message: `forkWithContext: Failed to clean up delegations dir ${destDelegationsDir}: ${e}`,
          },
        })
        .catch(() => {})
    })
    await client.session.delete({ path: { id: forkedSession.id } }).catch((e) => {
      client.app
        .log({
          body: {
            service: "worktree",
            level: "error",
            message: `forkWithContext: Failed to clean up forked session ${forkedSession.id}: ${e}`,
          },
        })
        .catch(() => {})
    })

    throw new WorktreeError(
      `Failed to copy session data: ${error instanceof Error ? error.message : String(error)}`,
      "forkWithContext",
      error,
    )
  }

  return { forkedSession, rootSessionId, planCopied, delegationsCopied }
}

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================

let db: Database | null = null
let projectRoot: string | null = null
let cleanupRegistered = false

function registerCleanupHandlers(database: Database): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  const cleanup = () => {
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      database.close()
    } catch {}
  }

  process.once("SIGTERM", cleanup)
  process.once("SIGINT", cleanup)
  process.once("beforeExit", cleanup)
}

async function getDb(log: Logger): Promise<Database> {
  if (db) return db

  if (!projectRoot) {
    throw new Error("Database not initialized: projectRoot not set. Call initDb() first.")
  }

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
    try {
      db = await initStateDb(projectRoot)
      registerCleanupHandlers(db)
      return db
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      log.warn(`Database init attempt ${attempt}/${DB_MAX_RETRIES} failed: ${lastError.message}`)

      if (attempt < DB_MAX_RETRIES) {
        Bun.sleepSync(DB_RETRY_DELAY_MS)
      }
    }
  }

  throw new Error(
    `Failed to initialize database after ${DB_MAX_RETRIES} attempts: ${lastError?.message}`,
  )
}

async function initDb(root: string, log: Logger): Promise<Database> {
  projectRoot = root
  return getDb(log)
}

// =============================================================================
// PLUGIN ENTRY
// =============================================================================

export default async function (ctx: {
  directory: string
  client: OpencodeClient
}) {
  const { directory, client } = ctx

  const log: Logger = {
    debug: (msg: string) =>
      client.app
        .log({ body: { service: "worktree", level: "debug", message: msg } })
        .catch(() => {}),
    info: (msg: string) =>
      client.app
        .log({ body: { service: "worktree", level: "info", message: msg } })
        .catch(() => {}),
    warn: (msg: string) =>
      client.app
        .log({ body: { service: "worktree", level: "warn", message: msg } })
        .catch(() => {}),
    error: (msg: string) =>
      client.app
        .log({ body: { service: "worktree", level: "error", message: msg } })
        .catch(() => {}),
  }

  const database = await initDb(directory, log)

  return {
    id: "opencode-worktree",

    tool: {
      worktree_create: tool({
        description:
          "Create a new git worktree for isolated development. A new terminal will open with OpenCode in the worktree.",
        args: {
          branch: tool.schema
            .string()
            .describe("Branch name for the worktree (e.g., 'feature/dark-mode')"),
          baseBranch: tool.schema
            .string()
            .optional()
            .describe("Base branch to create from (defaults to HEAD)"),
          launchMode: tool.schema
            .string()
            .optional()
            .describe("Launch mode: tmux-window (default), tmux-session, terminal, vscode"),
        },
        async execute(args, toolCtx) {
          const branchResult = branchNameSchema.safeParse(args.branch)
          if (!branchResult.success) {
            return `Invalid branch name: ${branchResult.error.issues[0]?.message}`
          }

          if (args.baseBranch) {
            const baseResult = branchNameSchema.safeParse(args.baseBranch)
            if (!baseResult.success) {
              return `Invalid base branch name: ${baseResult.error.issues[0]?.message}`
            }
          }

          let activeLaunchContext: ActiveLaunchContext
          try {
            activeLaunchContext = parseActiveLaunchContext(
              process.env as Record<string, string | undefined>,
            )
            activeLaunchContext = await ensureLaunchContextExecutable(
              activeLaunchContext,
              directory,
            )
            await ensureLaunchContextProfile(activeLaunchContext)
          } catch (error) {
            return `${error instanceof Error ? error.message : String(error)}`
          }

          const worktreeConfig = await loadWorktreeConfig(directory, log)

          const resolvedLaunchMode = (args.launchMode ?? worktreeConfig.launchMode ?? "tmux-window") as LaunchMode
          const launchModeResult = launchModeSchema.safeParse(resolvedLaunchMode)
          if (!launchModeResult.success) {
            return `Invalid launch mode: ${launchModeResult.error.issues[0]?.message}. Valid: tmux-window, tmux-session, terminal, vscode`
          }
          const launchMode = launchModeResult.data

          const result = await createWorktree(
            directory,
            args.branch,
            args.baseBranch,
            worktreeConfig.worktreePath,
          )
          if (!result.ok) {
            return `Failed to create worktree: ${result.error}`
          }

          const worktreePath = result.value

          if (worktreeConfig.sync.copyFiles.length > 0) {
            await copyFiles(directory, worktreePath, worktreeConfig.sync.copyFiles, log)
          }

          if (worktreeConfig.sync.symlinkDirs.length > 0) {
            await symlinkDirs(directory, worktreePath, worktreeConfig.sync.symlinkDirs, log)
          }

          if (worktreeConfig.hooks.postCreate.length > 0) {
            await runHooks(worktreePath, worktreeConfig.hooks.postCreate, log)
          }

          const projectId = await getProjectId(worktreePath, client)
          const { forkedSession, planCopied, delegationsCopied } = await forkWithContext(
            client,
            toolCtx.sessionID,
            projectId,
            async (sid) => {
              let currentId = sid
              for (let depth = 0; depth < MAX_SESSION_CHAIN_DEPTH; depth++) {
                const session = await client.session.get({ path: { id: currentId } })
                if (!session.data?.parentID) return currentId
                currentId = session.data.parentID
              }
              return currentId
            },
          )

          log.debug(
            `Forked session ${forkedSession.id}, plan: ${planCopied}, delegations: ${delegationsCopied}`,
          )

          const persistedLaunchMetadata = toPersistedLaunchMetadata(activeLaunchContext)
          const launchArgv = buildSessionLaunchArgv(forkedSession.id, persistedLaunchMetadata)
          const serializedLaunchMetadata = serializePersistedLaunchMetadata(persistedLaunchMetadata)

          const terminalResult = await launchWorktreeTerminal(
            launchMode,
            worktreePath,
            launchArgv,
            args.branch,
          )

          if (!terminalResult.success) {
            try {
              await client.session.delete({ path: { id: forkedSession.id } })
            } catch (cleanupError) {
              log.warn(
                `[worktree] Failed to clean up forked session ${forkedSession.id} after launch failure: ${cleanupError}`,
              )
            }
            return `Failed to launch worktree terminal (${launchMode}): ${terminalResult.error ?? "unknown error"}\nWorktree created at ${worktreePath}. Verify launch settings and retry.`
          }

          addSession(database, {
            id: forkedSession.id,
            branch: args.branch,
            path: worktreePath,
            createdAt: new Date().toISOString(),
            launchMode: serializedLaunchMetadata.launchMode,
            profile: serializedLaunchMetadata.profile,
            ocxBin: serializedLaunchMetadata.ocxBin,
          })

          return `Worktree created at ${worktreePath}\nLaunch mode: ${launchMode}\n\nA new ${launchMode === "tmux-window" ? "tmux window" : launchMode === "tmux-session" ? "tmux session" : launchMode === "terminal" ? "terminal window" : "VS Code window"} has been opened with OpenCode.`
        },
      }),

      worktree_delete: tool({
        description:
          "Delete the current worktree and clean up. Changes will be committed before removal.",
        args: {
          reason: tool.schema
            .string()
            .describe("Brief explanation of why you are calling this tool"),
        },
        async execute(_args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          if (!session) {
            return `No worktree associated with this session`
          }

          setPendingDelete(database, { branch: session.branch, path: session.path }, client)

          return `Worktree marked for cleanup. It will be removed when this session ends.`
        },
      }),

      worktree_list: tool({
        description: "List all active worktree sessions.",
        args: {},
        async execute() {
          const sessions = getAllSessions(database)
          if (sessions.length === 0) {
            return "No active worktrees."
          }

          const lines = sessions.map((s, i) => {
            const age = Date.now() - new Date(s.createdAt).getTime()
            const ageStr = age < 60000 ? `${Math.floor(age / 1000)}s ago` : age < 3600000 ? `${Math.floor(age / 60000)}m ago` : `${Math.floor(age / 3600000)}h ago`
            return `${i + 1}. ${s.branch} — ${s.path} (${ageStr}) [${s.launchMode}]`
          })

          return `Active worktrees (${sessions.length}):\n${lines.join("\n")}`
        },
      }),

      worktree_prune: tool({
        description: "Prune stale worktrees that no longer exist on disk.",
        args: {},
        async execute() {
          const sessions = getAllSessions(database)
          let pruned = 0

          for (const session of sessions) {
            const exists = await pathExists(session.path)
            if (!exists) {
              removeSession(database, session.branch)
              pruned++
              log.info(`[worktree] Pruned stale worktree: ${session.branch} (${session.path})`)
            }
          }

          const gitResult = await git(["worktree", "prune"], directory)
          if (!gitResult.ok) {
            log.warn(`[worktree] git worktree prune failed: ${gitResult.error}`)
          }

          return `Pruned ${pruned} stale worktree(s)${pruned === 0 ? ". All worktrees are healthy." : "."}`
        },
      }),

      worktree_merge: tool({
        description: "Merge a branch into the current branch in the worktree.",
        args: {
          branch: tool.schema
            .string()
            .describe("Branch to merge into the current branch"),
          noFf: tool.schema
            .boolean()
            .optional()
            .describe("Create a merge commit even if fast-forward is possible (no-ff)"),
          message: tool.schema
            .string()
            .optional()
            .describe("Merge commit message"),
        },
        async execute(args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          const mergeArgs = ["merge"]
          if (args.noFf) mergeArgs.push("--no-ff")
          if (args.message) {
            mergeArgs.push("-m", args.message)
          }
          mergeArgs.push(args.branch)

          const result = await git(mergeArgs, cwd)
          if (!result.ok) {
            return `Merge failed: ${result.error}`
          }

          return `Merged ${args.branch} into current branch.\n${result.value}`
        },
      }),

      worktree_rebase: tool({
        description: "Rebase the current branch onto a target in the worktree.",
        args: {
          onto: tool.schema
            .string()
            .optional()
            .describe("Branch or ref to rebase onto (defaults to upstream/main)"),
        },
        async execute(args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          const rebaseArgs = ["rebase"]
          if (args.onto) {
            rebaseArgs.push(args.onto)
          }

          const result = await git(rebaseArgs, cwd)
          if (!result.ok) {
            return `Rebase failed: ${result.error}`
          }

          return `Rebase completed.\n${result.value}`
        },
      }),

      worktree_cherry_pick: tool({
        description: "Cherry-pick one or more commits into the current branch in the worktree.",
        args: {
          commits: tool.schema
            .string()
            .describe("Space-separated commit SHAs to cherry-pick"),
        },
        async execute(args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          const shas = args.commits.trim().split(/\s+/).filter(Boolean)
          if (shas.length === 0) {
            return "No commit SHAs provided."
          }

          const result = await git(["cherry-pick", ...shas], cwd)
          if (!result.ok) {
            return `Cherry-pick failed: ${result.error}`
          }

          return `Cherry-picked ${shas.length} commit(s).\n${result.value}`
        },
      }),

      worktree_squash: tool({
        description: "Squash the N most recent commits into a single commit.",
        args: {
          count: tool.schema
            .number()
            .describe("Number of recent commits to squash"),
          message: tool.schema
            .string()
            .optional()
            .describe("Commit message for the squashed commit (default: 'squash: combine N commits')"),
        },
        async execute(args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          if (args.count < 2) {
            return "Count must be at least 2 to squash."
          }

          const softResult = await git(["reset", "--soft", `HEAD~${args.count}`], cwd)
          if (!softResult.ok) {
            return `Squash reset failed: ${softResult.error}`
          }

          const msg = args.message ?? `squash: combine ${args.count} commits`
          const commitResult = await git(["commit", "-m", msg], cwd)
          if (!commitResult.ok) {
            return `Squash commit failed: ${commitResult.error}`
          }

          return `Squashed ${args.count} commits into one.\n${commitResult.value}`
        },
      }),

      worktree_abort: tool({
        description: "Abort an in-progress merge, rebase, or cherry-pick in the worktree.",
        args: {},
        async execute(_args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          const headDir = path.join(cwd, ".git")
          let gitDir = headDir
          try {
            const headStat = await stat(headDir)
            if (headStat.isFile()) {
              const content = await Bun.file(headDir).text()
              const match = content.match(/^gitdir:\s*(.+)$/m)
              if (match) {
                gitDir = path.resolve(cwd, match[1].trim())
              }
            }
          } catch {}

          let abortCmd: string | null = null

          const mergeHeadPath = path.join(gitDir, "MERGE_HEAD")
          const rebaseMergeDir = path.join(gitDir, "rebase-merge")
          const rebaseApplyDir = path.join(gitDir, "rebase-apply")
          const cherryPickPath = path.join(gitDir, "CHERRY_PICK_HEAD")

          if (await pathExists(mergeHeadPath)) {
            abortCmd = "merge"
          } else if (await pathExists(rebaseMergeDir) || await pathExists(rebaseApplyDir)) {
            abortCmd = "rebase"
          } else if (await pathExists(cherryPickPath)) {
            abortCmd = "cherry-pick"
          }

          if (!abortCmd) {
            return "No in-progress merge, rebase, or cherry-pick found to abort."
          }

          const result = await git([abortCmd, "--abort"], cwd)
          if (!result.ok) {
            return `Abort failed: ${result.error}`
          }

          return `Aborted in-progress ${abortCmd}.`
        },
      }),

      worktree_conflicts: tool({
        description: "List files with merge conflicts in the current worktree.",
        args: {},
        async execute(_args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          const result = await git(["diff", "--name-only", "--diff-filter=U"], cwd)
          if (!result.ok) {
            return `Failed to list conflicts: ${result.error}`
          }

          const files = result.value.split("\n").filter(Boolean)
          if (files.length === 0) {
            return "No merge conflicts found."
          }

          return `Conflicted files (${files.length}):\n${files.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
        },
      }),

      worktree_checkout_theirs: tool({
        description:
          "Accept theirs (incoming) version for conflicted files. Use 'all' to accept theirs for all conflicted files.",
        args: {
          files: tool.schema
            .string()
            .optional()
            .describe("Space-separated file paths, or 'all' for all conflicted files"),
        },
        async execute(args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          let files: string[]
          if (!args.files || args.files.trim().toLowerCase() === "all") {
            const conflictsResult = await git(["diff", "--name-only", "--diff-filter=U"], cwd)
            if (!conflictsResult.ok) {
              return `Failed to list conflicts: ${conflictsResult.error}`
            }
            files = conflictsResult.value.split("\n").filter(Boolean)
          } else {
            files = args.files.trim().split(/\s+/).filter(Boolean)
          }

          if (files.length === 0) {
            return "No conflicted files to resolve."
          }

          const results: string[] = []
          for (const file of files) {
            const checkoutResult = await git(["checkout", "--theirs", file], cwd)
            if (!checkoutResult.ok) {
              results.push(`  FAILED: ${file} — ${checkoutResult.error}`)
              continue
            }
            const addResult = await git(["add", file], cwd)
            if (!addResult.ok) {
              results.push(`  CHECKOUT OK BUT ADD FAILED: ${file} — ${addResult.error}`)
            } else {
              results.push(`  RESOLVED (theirs): ${file}`)
            }
          }

          return `Accept theirs — ${files.length} file(s):\n${results.join("\n")}`
        },
      }),

      worktree_checkout_ours: tool({
        description:
          "Accept ours (current branch) version for conflicted files. Use 'all' to accept ours for all conflicted files.",
        args: {
          files: tool.schema
            .string()
            .optional()
            .describe("Space-separated file paths, or 'all' for all conflicted files"),
        },
        async execute(args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          let files: string[]
          if (!args.files || args.files.trim().toLowerCase() === "all") {
            const conflictsResult = await git(["diff", "--name-only", "--diff-filter=U"], cwd)
            if (!conflictsResult.ok) {
              return `Failed to list conflicts: ${conflictsResult.error}`
            }
            files = conflictsResult.value.split("\n").filter(Boolean)
          } else {
            files = args.files.trim().split(/\s+/).filter(Boolean)
          }

          if (files.length === 0) {
            return "No conflicted files to resolve."
          }

          const results: string[] = []
          for (const file of files) {
            const checkoutResult = await git(["checkout", "--ours", file], cwd)
            if (!checkoutResult.ok) {
              results.push(`  FAILED: ${file} — ${checkoutResult.error}`)
              continue
            }
            const addResult = await git(["add", file], cwd)
            if (!addResult.ok) {
              results.push(`  CHECKOUT OK BUT ADD FAILED: ${file} — ${addResult.error}`)
            } else {
              results.push(`  RESOLVED (ours): ${file}`)
            }
          }

          return `Accept ours — ${files.length} file(s):\n${results.join("\n")}`
        },
      }),

      worktree_conflict_status: tool({
        description: "Show detailed conflict status for the current worktree.",
        args: {},
        async execute(_args, toolCtx) {
          const session = getSession(database, toolCtx?.sessionID ?? "")
          const cwd = session?.path ?? directory

          const statusResult = await git(["status", "--porcelain"], cwd)
          if (!statusResult.ok) {
            return `Failed to get status: ${statusResult.error}`
          }

          const lines = statusResult.value.split("\n").filter(Boolean)
          const conflicted = lines.filter((line) => {
            const index = line.charCodeAt(0)
            const workTree = line.charCodeAt(1)
            return index === 85 || workTree === 85 || index === 65 || index === 68
          })

          if (conflicted.length === 0) {
            return "No conflicts detected. Working tree is clean."
          }

          const details = conflicted.map((line) => {
            const statusCode = line.substring(0, 2)
            const filePath = line.substring(3)
            let description = ""
            const x = statusCode.charCodeAt(0)
            const y = statusCode.charCodeAt(1)

            if (x === 85 && y === 85) description = "both modified"
            else if (x === 65 && y === 85) description = "added by us, modified by them"
            else if (x === 85 && y === 68) description = "modified by us, deleted by them"
            else if (x === 68 && y === 85) description = "deleted by us, modified by them"
            else if (x === 65 && y === 65) description = "both added"
            else description = `status ${statusCode}`

            return `  ${filePath} — ${description}`
          })

return `Conflict status (${conflicted.length} file(s)):\n${details.join("\n")}`
      },
    }),

    worktree_shared_sync: tool({
      description: "Sync shared files/dirs from main worktree to current worktree. Copies files and creates symlinks per .opencode/worktree.jsonc config.",
      args: {
        direction: tool.schema.string().optional().describe("Direction: 'to-worktree' (default) or 'from-worktree'"),
      },
      async execute(args, toolCtx) {
        const config = await loadWorktreeConfig(directory, log)
        const session = getSession(database, toolCtx?.sessionID ?? "")
        const worktreePath = session?.path ?? directory
        const direction = args.direction ?? "to-worktree"
        const source = direction === "from-worktree" ? worktreePath : directory
        const target = direction === "from-worktree" ? directory : worktreePath

        if (source === target) {
          return "Source and target are the same (main worktree). Nothing to sync."
        }

        const results: string[] = []

        if (config.sync.copyFiles.length > 0) {
          await copyFiles(source, target, config.sync.copyFiles, log)
          results.push(`Copied ${config.sync.copyFiles.length} file(s): ${config.sync.copyFiles.join(", ")}`)
        }

        if (config.sync.symlinkDirs.length > 0) {
          await symlinkDirs(source, target, config.sync.symlinkDirs, log)
          results.push(`Symlinked ${config.sync.symlinkDirs.length} dir(s): ${config.sync.symlinkDirs.join(", ")}`)
        }

        return results.length > 0
          ? `Synced (${direction}): ${results.join("; ")}`
          : "Nothing to sync. Configure copyFiles/symlinkDirs in .opencode/worktree.jsonc"
      },
    }),

    worktree_build_dir: tool({
      description: "Get or set the build output directory for this worktree. Useful for monorepos where each worktree needs isolated build artifacts.",
      args: {
        action: tool.schema.string().describe("Action: get, set, clean, path"),
        dir: tool.schema.string().optional().describe("Directory path (for 'set' action)"),
      },
      async execute(args, toolCtx) {
        const session = getSession(database, toolCtx?.sessionID ?? "")
        const worktreePath = session?.path ?? directory
        const buildDir = path.join(worktreePath, ".opencode", "build.json")

        switch (args.action) {
          case "get": {
            try {
              const file = Bun.file(buildDir)
              if (!(await file.exists())) {
                return "No build directory configured. Use 'set' to configure one."
              }
              const data = await file.json() as { dir: string }
              const resolved = path.resolve(worktreePath, data.dir)
              const exists = await stat(resolved).then(s => s.isDirectory()).catch(() => false)
              return `Build dir: ${data.dir} (resolved: ${resolved}, exists: ${exists})`
            } catch {
              return "Failed to read build directory config."
            }
          }
          case "set": {
            if (!args.dir) return "Error: dir is required for 'set' action"
            if (isPathSafe(args.dir, worktreePath, log)) {
              await mkdir(path.join(worktreePath, ".opencode"), { recursive: true })
              await Bun.write(buildDir, JSON.stringify({ dir: args.dir, setAt: new Date().toISOString() }))
              return `Build directory set to: ${args.dir}`
            }
            return "Error: directory path must be relative and safe (no .. or absolute paths)"
          }
          case "clean": {
            try {
              const file = Bun.file(buildDir)
              if (!(await file.exists())) {
                return "No build directory configured. Use 'set' first."
              }
              const data = await file.json() as { dir: string }
              const resolved = path.resolve(worktreePath, data.dir)
              await rm(resolved, { recursive: true, force: true }).catch(() => {})
              await mkdir(resolved, { recursive: true }).catch(() => {})
              return `Cleaned build directory: ${data.dir}`
            } catch {
              return "Failed to clean build directory."
            }
          }
          case "path": {
            try {
              const file = Bun.file(buildDir)
              if (!(await file.exists())) {
                return worktreePath
              }
              const data = await file.json() as { dir: string }
              return path.resolve(worktreePath, data.dir)
            } catch {
              return worktreePath
            }
          }
          default:
            return `Unknown action: ${args.action}. Use: get, set, clean, path`
        }
      },
    }),

    worktree_shared_list: tool({
      description: "List shared files and directories configured for worktree sync.",
      args: {},
      async execute(_args) {
        const config = await loadWorktreeConfig(directory, log)
        const lines: string[] = []

        if (config.sync.copyFiles.length > 0) {
          lines.push(`Copy files (${config.sync.copyFiles.length}):`)
          for (const f of config.sync.copyFiles) lines.push(`  ${f}`)
        } else {
          lines.push("Copy files: (none)")
        }

        if (config.sync.symlinkDirs.length > 0) {
          lines.push(`Symlink dirs (${config.sync.symlinkDirs.length}):`)
          for (const d of config.sync.symlinkDirs) lines.push(`  ${d} -> ${path.resolve(directory, d)}`)
        } else {
          lines.push("Symlink dirs: (none)")
        }

        if (config.sync.exclude.length > 0) {
          lines.push(`Exclude patterns (${config.sync.exclude.length}):`)
          for (const e of config.sync.exclude) lines.push(`  ${e}`)
        }

        lines.push(`\nConfig: ${path.join(directory, ".opencode", "worktree.jsonc")}`)
        return lines.join("\n")
      },
    }),
    },

  event: async ({ event }: { event: Event }): Promise<void> => {
      if (event.type !== "session.idle") return

      const pendingDelete = getPendingDelete(database)
      if (pendingDelete) {
        const { path: worktreePath, branch } = pendingDelete

        const config = await loadWorktreeConfig(directory, log)
        if (config.hooks.preDelete.length > 0) {
          await runHooks(worktreePath, config.hooks.preDelete, log)
        }

        const addResult = await git(["add", "-A"], worktreePath)
        if (!addResult.ok) log.warn(`[worktree] git add failed: ${addResult.error}`)

        const commitResult = await git(
          ["commit", "-m", "chore(worktree): session snapshot", "--allow-empty"],
          worktreePath,
        )
        if (!commitResult.ok) log.warn(`[worktree] git commit failed: ${commitResult.error}`)

        const removeResult = await removeWorktree(directory, worktreePath)
        if (!removeResult.ok) {
          log.warn(`[worktree] Failed to remove worktree: ${removeResult.error}`)
        }

        clearPendingDelete(database)
        removeSession(database, branch)
      }
    },
  }
}
