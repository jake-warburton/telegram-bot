import TelegramBot from 'node-telegram-bot-api';
import { exec, execFile, spawn, ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_CHAT_STATE, loadState, saveState } from './state.js';
import type { BotState, ChatState as StoredChatState, TaskState as StoredTaskState } from './state.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// --- Config ---

interface CliTool {
  command: string;
  args: string[];
  promptArg: 'append';
  description: string;
}

type ChatProvider = 'claude' | 'codex';
type TaskMode = 'standard' | 'overnight';
type TaskPhase = 'red' | 'green' | 'refactor' | 'verify';

const CODEX_SKIP_GIT_REPO_CHECK_ARG = '--skip-git-repo-check';
const CHAT_TRANSCRIPT_TAIL_LINES = 200;

interface RawConfig {
  cli_tools: Record<string, CliTool>;
  projects_dir?: string;
  projects?: string[];
  default_project: string;
  command_timeout_ms: number;
}

interface Config {
  cli_tools: Record<string, CliTool>;
  projects: string[];
  default_project: string;
  command_timeout_ms: number;
}

interface ComputerUseSession {
  id: string;
  label: string | null;
  created_at: string;
}

interface ComputerUseSessionState extends ComputerUseSession {
  updated_at?: string;
  last_frontmost_app?: string | null;
  current_recording?: {
    path: string;
    started_at: string;
  };
  artifacts?: ComputerUseArtifact[];
  recording?: boolean;
  artifacts_count?: number;
}

interface ComputerUseArtifact {
  id: string;
  type: string;
  path: string;
  mime_type: string;
  created_at: string;
  size_bytes: number;
}

interface ComputerUseScreenshotResult {
  ok: true;
  session_id: string;
  action: 'screenshot';
  summary: string;
  state: {
    frontmost_app: string | null;
  };
  artifact: ComputerUseArtifact;
}

interface ComputerUseRecordingStartResult {
  ok: true;
  session_id: string;
  action: 'recording_start';
  summary: string;
  state: {
    recording: boolean;
  };
}

interface ComputerUseRecordingStopResult {
  ok: true;
  session_id: string;
  action: 'recording_stop';
  summary: string;
  state: {
    recording: boolean;
  };
  artifact: ComputerUseArtifact;
}

interface ComputerUseSessionResponse {
  ok: true;
  session: ComputerUseSession;
}

interface ComputerUseStateResponse {
  ok: true;
  session_id: string;
  summary: string;
  state: {
    frontmost_app: string | null;
    recording: boolean;
    artifacts_count: number;
  };
  session: ComputerUseSessionState;
}

interface ComputerUseArtifactsResponse {
  ok: true;
  session_id: string;
  summary: string;
  artifacts: ComputerUseArtifact[];
}

interface ComputerUseLaunchAppResult {
  ok: true;
  session_id: string;
  action: 'launch_app';
  summary: string;
  state: {
    requested_app: string;
    frontmost_app: string | null;
  };
}

interface CodexMcpServerConfig {
  name: string;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
  };
}

interface AutonomousTaskTurnResult {
  status: 'completed' | 'continue' | 'blocked';
  summary: string;
  evidence: string;
  phase?: TaskPhase;
  tests_ran?: string;
  next_focus?: string;
}

const COMPUTER_USE_MCP_SERVER_NAME = 'computer-use';
const TELEGRAM_POLLING_DIAGNOSTIC_INTERVAL_MS = 60_000;
const AUTONOMOUS_TASK_DEFAULT_MAX_ATTEMPTS = 5;
const AUTONOMOUS_TASK_OVERNIGHT_DEFAULT_MAX_ATTEMPTS = 48;
const AUTONOMOUS_TASK_OVERNIGHT_DEFAULT_MAX_RUNTIME_HOURS = 8;
const COMPACT_CHAT_RECENT_TURNS = 2;
const COMPACT_CHAT_SUMMARY_MAX_CHARS = 4_000;
const COMPACT_CHAT_TURN_SUMMARY_MAX_CHARS = 900;
const AUTONOMOUS_TASK_RECENT_MEMORY_ENTRIES = 4;
const AUTONOMOUS_TASK_MEMORY_MAX_CHARS = 4_000;

interface TelegramHostLookupResult {
  host: string;
  ok: boolean;
  address?: string;
  family?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface TelegramUrlCheckResult {
  url: string;
  ok: boolean;
  status?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface TelegramConnectivityDiagnostics {
  summary: string;
  telegramDns: TelegramHostLookupResult;
  generalDns: TelegramHostLookupResult;
  telegramHttps: TelegramUrlCheckResult;
}

export function loadConfig(path: string): Config {
  const raw: RawConfig = JSON.parse(readFileSync(path, 'utf-8'));

  let projects = raw.projects ?? [];
  if (raw.projects_dir) {
    const dirs = readdirSync(raw.projects_dir)
      .map((name) => join(raw.projects_dir!, name))
      .filter((p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      })
      .sort();
    projects = [...projects, ...dirs];
  }

  return { ...raw, projects };
}

// --- Pure helpers ---

export function isAllowedUser(userId: number, allowedIds: number[]): boolean {
  return allowedIds.includes(userId);
}

export type FormattedOutput =
  | { type: 'text'; content: string }
  | { type: 'file'; content: string };

export function formatOutput(output: string): FormattedOutput {
  if (!output) {
    return { type: 'text', content: '(no output)' };
  }

  const wrapped = '```\n' + output + '\n```';
  if (wrapped.length <= 4096) {
    return { type: 'text', content: wrapped };
  }

  return { type: 'file', content: output };
}

export function parseProjectArg(
  arg: string,
  projects: string[],
): string | null {
  const idx = parseInt(arg, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= projects.length) {
    return projects[idx - 1];
  }

  const match = projects.find((p) => basename(p) === arg);
  return match ?? null;
}

function normalizeCodexToolArgs(toolArgs: string[]): string[] {
  return toolArgs.filter((arg) => arg !== '--quiet');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getChatTranscriptRoot(homeDir = process.env.HOME): string {
  if (homeDir) {
    return join(homeDir, 'Library', 'Logs', 'telegram-bot', 'chat-transcripts');
  }
  return join(tmpdir(), 'telegram-bot-chat-transcripts');
}

export function getChatTranscriptPath(chatId: number, homeDir = process.env.HOME): string {
  return join(getChatTranscriptRoot(homeDir), `chat-${chatId}.log`);
}

export function buildChatTranscriptTailCommand(filePath: string): string {
  const quotedPath = shellQuote(filePath);
  return [
    'clear',
    `echo "telegram-bot chat transcript"`,
    `echo "Watching: ${filePath.replace(/"/g, '\\"')}"`,
    'echo ""',
    `touch ${quotedPath}`,
    `tail -n ${CHAT_TRANSCRIPT_TAIL_LINES} -F ${quotedPath}`,
  ].join('; ');
}

function appendChatTranscript(filePath: string, content: string): void {
  mkdirSync(getChatTranscriptRoot(), { recursive: true });
  writeFileSync(filePath, content, { flag: 'a' });
}

function initializeChatTranscript(
  filePath: string,
  provider: ChatProvider,
  project: string,
  label: string,
): void {
  const banner = [
    '',
    '============================================================',
    `${new Date().toISOString()} ${label} session started`,
    `Provider: ${provider}`,
    `Project: ${project}`,
    `Transcript: ${filePath}`,
    '============================================================',
    '',
  ].join('\n');
  appendChatTranscript(filePath, banner);
}

function buildAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function openChatTranscriptViewer(filePath: string): Promise<void> {
  mkdirSync(getChatTranscriptRoot(), { recursive: true });
  writeFileSync(filePath, '', { flag: 'a' });

  await execFileAsync('/usr/bin/osascript', [
    '-e',
    'tell application "Terminal" to activate',
    '-e',
    `tell application "Terminal" to do script ${buildAppleScriptString(buildChatTranscriptTailCommand(filePath))}`,
  ]);
}

export function buildCodexExecArgs(
  toolArgs: string[],
  prompt: string,
): string[] {
  const args = normalizeCodexToolArgs(toolArgs);

  return ['exec', ...args, CODEX_SKIP_GIT_REPO_CHECK_ARG, '--json', prompt];
}

export function buildCodexChatArgs(
  toolArgs: string[],
  prompt: string,
  sessionId?: string,
): string[] {
  const args = normalizeCodexToolArgs(toolArgs);

  if (sessionId) {
    return ['exec', 'resume', ...args, CODEX_SKIP_GIT_REPO_CHECK_ARG, '--json', sessionId, prompt];
  }

  return buildCodexExecArgs(toolArgs, prompt);
}

export function buildCompactedCodexChatArgs(
  toolArgs: string[],
  prompt: string,
): string[] {
  const args = normalizeCodexToolArgs(toolArgs);
  return ['exec', ...args, CODEX_SKIP_GIT_REPO_CHECK_ARG, '--ephemeral', '--json', prompt];
}

export function buildComputerUseScreenshotCaption(
  sessionId: string,
  summary: string,
  frontmostApp: string | null,
): string {
  const lines = [`Session: ${sessionId}`, summary];
  if (frontmostApp) {
    lines.push(`Frontmost app: ${frontmostApp}`);
  }
  return lines.join('\n');
}

export function buildComputerUseRecordingCaption(
  sessionId: string,
  summary: string,
): string {
  return [`Session: ${sessionId}`, summary].join('\n');
}

export function buildComputerUseStateSummary(
  sessionId: string,
  summary: string,
  state: {
    frontmost_app: string | null;
    recording: boolean;
    artifacts_count: number;
  },
): string {
  const lines = [
    `Session: ${sessionId}`,
    summary,
    `Frontmost app: ${state.frontmost_app ?? 'Unknown'}`,
    `Recording: ${state.recording ? 'on' : 'off'}`,
    `Artifacts: ${state.artifacts_count}`,
  ];
  return lines.join('\n');
}

export function buildComputerUseArtifactsSummary(
  sessionId: string,
  summary: string,
  artifacts: ComputerUseArtifact[],
): string {
  const lines = [`Session: ${sessionId}`, summary];
  if (artifacts.length === 0) {
    lines.push('No artifacts yet.');
    return lines.join('\n');
  }

  for (const artifact of artifacts.slice(-10)) {
    lines.push(`- ${artifact.type}: ${basename(artifact.path)}`);
  }

  return lines.join('\n');
}

export function buildComputerUseCodexPrompt(
  sessionId: string,
  prompt: string,
): string {
  const instructions = buildComputerUseCodexInstructions(sessionId);
  return [instructions, '', 'User request:', prompt].join('\n');
}

export function buildComputerUseCodexInstructions(sessionId: string): string {
  return [
    'Computer-use guidance:',
    `- Use the \`${COMPUTER_USE_MCP_SERVER_NAME}\` MCP tools when the task needs GUI interaction on this Mac.`,
    `- Reuse the active computer-use session id \`${sessionId}\` unless you have a reason to create another one.`,
    '- Capture a screenshot before acting when the current screen state is unclear.',
    '- Capture another screenshot after GUI actions when you need to verify the result.',
  ].join('\n');
}

function normalizeCompactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampCompactText(text: string, maxChars: number): string {
  const normalized = normalizeCompactText(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 16).trimEnd()} [...truncated]`;
}

function appendCompactedMemory(
  existing: string | undefined,
  entry: string,
  maxChars: number,
): string {
  const next = existing ? `${existing}\n${entry}` : entry;
  if (next.length <= maxChars) {
    return next;
  }

  return next.slice(next.length - maxChars);
}

interface CompactChatTurn {
  user: string;
  assistant: string;
}

interface AutonomousTaskPromptOptions {
  mode?: TaskMode;
  phase?: TaskPhase;
  memory?: string;
  previousSummary?: string;
  sessionId?: string;
}

export function buildCompactedChatTurnPrompt(
  prompt: string,
  preamble?: string,
  compactSummary?: string,
  recentTurns: CompactChatTurn[] = [],
): string {
  const lines: string[] = [];

  if (preamble) {
    lines.push(preamble);
    lines.push('');
  }

  if (compactSummary || recentTurns.length > 0) {
    lines.push('Conversation memory:');
    lines.push('- This is a compacted continuation of an existing Telegram chat.');
    lines.push('- Prefer the current repository state and fresh tool output over stale chat memory.');

    if (compactSummary) {
      lines.push('');
      lines.push('Earlier summary:');
      lines.push(compactSummary);
    }

    if (recentTurns.length > 0) {
      lines.push('');
      lines.push('Recent turns:');
      for (const turn of recentTurns) {
        lines.push(`User: ${turn.user}`);
        lines.push(`Assistant: ${turn.assistant}`);
        lines.push('');
      }
      if (lines.at(-1) === '') {
        lines.pop();
      }
    }

    lines.push('');
  }

  lines.push('Latest user message:');
  lines.push(prompt);
  return lines.join('\n');
}

export function buildAutonomousTaskPrompt(
  goal: string,
  currentProject: string,
  attempt: number,
  maxAttempts: number,
  options: AutonomousTaskPromptOptions = {},
): string {
  const mode = options.mode ?? 'standard';
  const lines = [
    'You are running an autonomous implementation task from Telegram.',
    `Working directory: ${currentProject}`,
    `Attempt: ${attempt}/${maxAttempts}`,
    `Goal: ${goal}`,
    `Mode: ${mode === 'overnight' ? 'overnight TDD loop' : 'standard autonomous run'}`,
    'Requirements:',
    '- Make concrete progress on the task. Do not stop at a plan unless you are blocked.',
    '- Use tests, logs, screenshots, recordings, accessibility state, and app inspection when they help verify the task.',
    '- If GUI interaction is needed, use the computer-use MCP tools.',
    '- Prefer screenshot-based verification after UI changes.',
    '- Return status "completed" only if the task is actually done or the implementation is in a clearly acceptable stopping state.',
    '- Return status "continue" if another autonomous attempt should run.',
    '- Return status "blocked" if human input, missing credentials, or an external dependency is blocking progress.',
  ];

  if (mode === 'overnight') {
    lines.push('- Run in small TDD increments: red, green, refactor, then verify.');
    lines.push('- Start each increment by identifying or adding a failing test or observable check.');
    lines.push('- Do not claim green unless you ran the relevant tests or checks and they passed.');
    lines.push('- Use refactor steps to improve naming, structure, and test clarity after green.');
    lines.push('- If the task is too large, cut scope to a smaller vertical slice and keep the loop moving.');
  }

  if (options.phase) {
    lines.push(`- Current TDD phase: ${options.phase}.`);
  }

  if (options.sessionId) {
    lines.push('');
    lines.push(buildComputerUseCodexInstructions(options.sessionId));
  }

  if (options.memory) {
    lines.push('');
    lines.push('Compacted task memory:');
    lines.push(options.memory);
  }

  if (options.previousSummary) {
    lines.push('');
    lines.push('Previous attempt summary:');
    lines.push(options.previousSummary);
  }

  lines.push('');
  lines.push('Return a JSON object that matches the required output schema.');

  return lines.join('\n');
}

export function buildAutonomousTaskStatusSummary(task: StoredTaskState): string {
  const lines = [
    `Task: ${task.id}`,
    `Status: ${task.status}`,
    `Mode: ${task.mode ?? 'standard'}`,
    `Attempt: ${task.attempt}/${task.maxAttempts}`,
    `Project: ${basename(task.currentProject)}`,
    `Goal: ${task.goal}`,
  ];

  if (task.phase) {
    lines.push(`Phase: ${task.phase}`);
  }

  if (task.deadlineAt) {
    lines.push(`Deadline: ${task.deadlineAt}`);
  }

  if (task.lastSummary) {
    lines.push(`Last summary: ${task.lastSummary}`);
  }

  return lines.join('\n');
}

function formatCompactChatTurn(turn: CompactChatTurn): string {
  return `User: ${turn.user}\nAssistant: ${turn.assistant}`;
}

function updateCompactChatHistory(
  compactSummary: string | undefined,
  recentTurns: CompactChatTurn[],
  prompt: string,
  response: string,
): { compactSummary?: string; recentTurns: CompactChatTurn[] } {
  const nextTurn: CompactChatTurn = {
    user: clampCompactText(prompt, 280),
    assistant: clampCompactText(response, 520),
  };
  const nextRecentTurns = [...recentTurns];
  let nextSummary = compactSummary;

  if (nextRecentTurns.length >= COMPACT_CHAT_RECENT_TURNS) {
    const shifted = nextRecentTurns.shift();
    if (shifted) {
      nextSummary = appendCompactedMemory(
        nextSummary,
        formatCompactChatTurn(shifted),
        COMPACT_CHAT_SUMMARY_MAX_CHARS,
      );
    }
  }

  nextRecentTurns.push(nextTurn);
  return { compactSummary: nextSummary, recentTurns: nextRecentTurns };
}

function formatAutonomousTaskMemoryEntry(
  attempt: number,
  result: AutonomousTaskTurnResult,
): string {
  const lines = [
    `Attempt ${attempt}${result.phase ? ` (${result.phase})` : ''}: ${clampCompactText(result.summary, 180)}`,
    `Evidence: ${clampCompactText(result.evidence, 220)}`,
  ];

  if (result.tests_ran) {
    lines.push(`Tests: ${clampCompactText(result.tests_ran, 180)}`);
  }

  if (result.next_focus) {
    lines.push(`Next focus: ${clampCompactText(result.next_focus, 180)}`);
  }

  return lines.join('\n');
}

function buildAutonomousTaskMemory(
  compactSummary: string | undefined,
  recentEntries: string[],
): string | undefined {
  const parts = [compactSummary, recentEntries.join('\n\n')].filter((value): value is string => Boolean(value && value.trim()));
  if (parts.length === 0) {
    return undefined;
  }

  return parts.join('\n\n');
}

type GuidedAction =
  | 'task_goal'
  | 'launch_app'
  | 'change_project';

export function buildMainReplyKeyboard(): TelegramBot.ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: 'Task' }, { text: 'Codex Chat' }, { text: 'Status' }],
      [{ text: 'Screenshot' }, { text: 'Launch App' }, { text: 'Projects' }],
      [{ text: 'Change Project' }, { text: 'Task Status' }, { text: 'Task Stop' }],
      [{ text: 'Chat Terminal' }, { text: 'End Chat' }, { text: 'Help' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function buildAutonomousTaskSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'evidence'],
    properties: {
      status: {
        type: 'string',
        enum: ['completed', 'continue', 'blocked'],
      },
      summary: {
        type: 'string',
        minLength: 1,
      },
      evidence: {
        type: 'string',
        minLength: 1,
      },
      phase: {
        type: 'string',
        enum: ['red', 'green', 'refactor', 'verify'],
      },
      tests_ran: {
        type: 'string',
      },
      next_focus: {
        type: 'string',
      },
    },
  };
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? `${fallback}`, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function getAutonomousTaskMaxAttempts(mode: TaskMode): number {
  if (mode === 'overnight') {
    return parsePositiveIntEnv(
      'TELEGRAM_TASK_OVERNIGHT_MAX_ATTEMPTS',
      AUTONOMOUS_TASK_OVERNIGHT_DEFAULT_MAX_ATTEMPTS,
    );
  }

  return parsePositiveIntEnv('TELEGRAM_TASK_MAX_ATTEMPTS', AUTONOMOUS_TASK_DEFAULT_MAX_ATTEMPTS);
}

function getAutonomousTaskMaxRuntimeMs(mode: TaskMode): number | undefined {
  if (mode !== 'overnight') {
    return undefined;
  }

  const hours = parsePositiveIntEnv(
    'TELEGRAM_TASK_OVERNIGHT_MAX_RUNTIME_HOURS',
    AUTONOMOUS_TASK_OVERNIGHT_DEFAULT_MAX_RUNTIME_HOURS,
  );
  return hours * 60 * 60 * 1000;
}

function buildTelegramFileOptions(filePath: string): { filename: string; contentType: string } {
  const extension = extname(filePath).toLowerCase();
  const contentTypeByExtension: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
  };

  return {
    filename: basename(filePath),
    contentType: contentTypeByExtension[extension] ?? 'application/octet-stream',
  };
}

async function lookupHost(host: string): Promise<TelegramHostLookupResult> {
  try {
    const result = await lookup(host);
    return {
      host,
      ok: true,
      address: result.address,
      family: result.family,
    };
  } catch (error: any) {
    return {
      host,
      ok: false,
      errorCode: error?.code,
      errorMessage: error?.message,
    };
  }
}

async function checkTelegramUrl(url: string, timeoutMs: number): Promise<TelegramUrlCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });

    return {
      url,
      ok: true,
      status: response.status,
    };
  } catch (error: any) {
    return {
      url,
      ok: false,
      errorCode: error?.code ?? (error?.name === 'AbortError' ? 'TIMEOUT' : undefined),
      errorMessage: error?.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildTelegramConnectivitySummary(
  diagnostics: {
    telegramDns: TelegramHostLookupResult;
    generalDns: TelegramHostLookupResult;
    telegramHttps: TelegramUrlCheckResult;
  },
): string {
  if (!diagnostics.generalDns.ok) {
    return 'System DNS lookup is failing beyond Telegram. Check the Mac DNS resolver, router, VPN, or firewall.';
  }

  if (!diagnostics.telegramDns.ok) {
    return 'General DNS works, but api.telegram.org does not resolve. Check DNS filtering, split-DNS, or Telegram blocking.';
  }

  if (!diagnostics.telegramHttps.ok) {
    if (['ETIMEDOUT', 'TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(
      diagnostics.telegramHttps.errorCode ?? '',
    )) {
      return 'DNS resolves, but HTTPS to api.telegram.org is timing out or blocked on port 443.';
    }

    return 'api.telegram.org resolves, but HTTPS still fails. Check outbound network access, TLS interception, or a proxy.';
  }

  return 'api.telegram.org resolves and responds over HTTPS.';
}

async function getTelegramConnectivityDiagnostics(): Promise<TelegramConnectivityDiagnostics> {
  const [telegramDns, generalDns, telegramHttps] = await Promise.all([
    lookupHost('api.telegram.org'),
    lookupHost('google.com'),
    checkTelegramUrl('https://api.telegram.org', 8_000),
  ]);

  return {
    summary: buildTelegramConnectivitySummary({
      telegramDns,
      generalDns,
      telegramHttps,
    }),
    telegramDns,
    generalDns,
    telegramHttps,
  };
}

function formatTelegramHostLookup(result: TelegramHostLookupResult): string {
  if (result.ok) {
    return `${result.host}: ok (${result.address}, IPv${result.family})`;
  }

  return `${result.host}: ${result.errorCode ?? 'ERROR'}${result.errorMessage ? ` (${result.errorMessage})` : ''}`;
}

function formatTelegramUrlCheck(result: TelegramUrlCheckResult): string {
  if (result.ok) {
    return `${result.url}: ok (${result.status})`;
  }

  return `${result.url}: ${result.errorCode ?? 'ERROR'}${result.errorMessage ? ` (${result.errorMessage})` : ''}`;
}

export function buildTelegramWebSendPhotoBookmarklet(): string {
  const script = [
    '(()=>{',
    "const modalAnchor=[...document.querySelectorAll('*')].find((el)=>(el.textContent||'').includes('Add a caption'));",
    "if(!modalAnchor){alert('Send Photo modal not found');return;}",
    'let node=modalAnchor;',
    'for(let i=0;i<8&&node;i+=1){',
    "const buttons=[...node.querySelectorAll('button,[role=\"button\"]')]",
    ".filter((el)=>el instanceof HTMLElement&&el.offsetParent)",
    '.sort((a,b)=>{',
    'const rectA=a.getBoundingClientRect();',
    'const rectB=b.getBoundingClientRect();',
    'return (rectB.right+rectB.bottom)-(rectA.right+rectA.bottom);',
    '});',
    'if(buttons.length>0){buttons[0].click();return;}',
    'node=node.parentElement;',
    '}',
    "alert('Send button not found');",
    '})()',
  ].join('');

  return `javascript:${script}`;
}

export function buildCodexMcpAddArgs(
  serverPath: string,
  hostUrl: string,
): string[] {
  return [
    'mcp',
    'add',
    COMPUTER_USE_MCP_SERVER_NAME,
    '--env',
    `COMPUTER_USE_HOST_URL=${hostUrl}`,
    '--',
    'node',
    serverPath,
  ];
}

export function isExpectedComputerUseMcpServer(
  server: unknown,
  serverPath: string,
  hostUrl: string,
): boolean {
  if (!server || typeof server !== 'object') {
    return false;
  }

  const candidate = server as CodexMcpServerConfig;
  const transport = candidate.transport;
  if (!transport) {
    return false;
  }

  return candidate.name === COMPUTER_USE_MCP_SERVER_NAME
    && transport.type === 'stdio'
    && transport.command === 'node'
    && Array.isArray(transport.args)
    && transport.args.length === 1
    && transport.args[0] === serverPath
    && transport.env?.COMPUTER_USE_HOST_URL === hostUrl;
}

function getComputerUseHostUrl(): string | null {
  const raw = process.env.COMPUTER_USE_HOST_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

function getComputerUseHostRepoPath(): string {
  const override = process.env.COMPUTER_USE_HOST_REPO?.trim();
  if (override) {
    return override;
  }

  return join(import.meta.dirname, '..', '..', 'computer-use-host');
}

function getComputerUseMcpRepoPath(): string {
  const override = process.env.COMPUTER_USE_MCP_REPO?.trim();
  if (override) {
    return override;
  }

  return join(import.meta.dirname, '..', '..', 'computer-use-mcp');
}

function getComputerUseMcpServerPath(): string {
  return join(getComputerUseMcpRepoPath(), 'src', 'server.js');
}

function getCodexConfigCwd(): string {
  const home = process.env.HOME?.trim();
  return home || tmpdir();
}

function getComputerUseWatchIntervalMs(): number {
  const raw = parseInt(process.env.COMPUTER_USE_WATCH_INTERVAL_MS ?? '30000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
}

function shouldAutostartComputerUseHost(): boolean {
  const raw = process.env.COMPUTER_USE_HOST_AUTOSTART?.trim().toLowerCase();
  if (!raw) {
    return true;
  }

  return !['0', 'false', 'no', 'off'].includes(raw);
}

async function getComputerUseStartupDiagnostics(): Promise<string[]> {
  const lines: string[] = [];
  const baseUrl = getComputerUseHostUrl();

  if (!baseUrl) {
    lines.push('COMPUTER_USE_HOST_URL: missing');
    return lines;
  }

  lines.push(`COMPUTER_USE_HOST_URL: ${baseUrl}`);
  lines.push(`COMPUTER_USE_HOST_AUTOSTART: ${shouldAutostartComputerUseHost() ? 'on' : 'off'}`);

  try {
    const hostRepo = getComputerUseHostRepoPath();
    const hostRepoExists = statSync(hostRepo).isDirectory();
    lines.push(`Host repo: ${hostRepoExists ? 'ok' : 'not a directory'} (${hostRepo})`);
  } catch {
    lines.push(`Host repo: missing (${getComputerUseHostRepoPath()})`);
  }

  try {
    const mcpServerPath = getComputerUseMcpServerPath();
    const mcpServerExists = statSync(mcpServerPath).isFile();
    lines.push(`MCP server: ${mcpServerExists ? 'ok' : 'missing'} (${mcpServerPath})`);
  } catch {
    lines.push(`MCP server: missing (${getComputerUseMcpServerPath()})`);
  }

  const launchAgentsDir = process.env.HOME
    ? join(process.env.HOME, 'Library', 'LaunchAgents')
    : null;
  if (launchAgentsDir) {
    try {
      accessSync(launchAgentsDir, constants.W_OK);
      lines.push(`LaunchAgents dir writable: yes (${launchAgentsDir})`);
    } catch {
      lines.push(`LaunchAgents dir writable: no (${launchAgentsDir})`);
    }
  } else {
    lines.push('LaunchAgents dir writable: unknown (HOME missing)');
  }

  try {
    const codexPath = (await execAsync('command -v codex')).stdout.trim();
    lines.push(`codex CLI: ${codexPath ? `ok (${codexPath})` : 'not found'}`);
  } catch {
    lines.push('codex CLI: not found in PATH');
  }

  lines.push(`Host health: ${(await isComputerUseHostHealthy()) ? 'ok' : 'unreachable'}`);
  return lines;
}

async function isComputerUseHostHealthy(): Promise<boolean> {
  const baseUrl = getComputerUseHostUrl();
  if (!baseUrl) {
    return false;
  }

  try {
    const response = await fetch(`${baseUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForComputerUseHostHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isComputerUseHostHealthy()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return isComputerUseHostHealthy();
}

function buildComputerUseHostSpawnEnv(baseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname) {
      env.COMPUTER_USE_HOST_BIND = parsed.hostname;
    }
    if (parsed.port) {
      env.COMPUTER_USE_HOST_PORT = parsed.port;
    }
  } catch {
    // Ignore URL parsing issues and let the host use its own defaults.
  }

  return env;
}

function startComputerUseHostDirectly(repoPath: string, baseUrl: string): void {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: repoPath,
    env: buildComputerUseHostSpawnEnv(baseUrl),
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}

async function ensureComputerUseHostAvailable(): Promise<void> {
  const baseUrl = getComputerUseHostUrl();
  if (!baseUrl) {
    throw new Error('COMPUTER_USE_HOST_URL is not configured.');
  }

  if (await isComputerUseHostHealthy()) {
    return;
  }

  const repoPath = getComputerUseHostRepoPath();
  try {
    if (!statSync(repoPath).isDirectory()) {
      throw new Error(`Computer use host repo is not a directory: ${repoPath}`);
    }
  } catch (error) {
    throw new Error(
      `Computer use host repo not found at ${repoPath}. Set COMPUTER_USE_HOST_REPO if needed.`,
    );
  }

  let ensureError: string | null = null;

  try {
    await runCliTool('npm', ['run', 'ensure'], repoPath, 30_000);
  } catch (error: any) {
    ensureError = error.message;
  }

  if (await waitForComputerUseHostHealthy(10_000)) {
    return;
  }

  startComputerUseHostDirectly(repoPath, baseUrl);

  if (await waitForComputerUseHostHealthy(15_000)) {
    return;
  }

  if (ensureError) {
    throw new Error(
      `Computer use host did not become healthy at ${baseUrl}. LaunchAgent bootstrap failed with: ${ensureError}`,
    );
  }

  throw new Error(`Computer use host did not become healthy at ${baseUrl}.`);
}

function ensureComputerUseMcpFilesAvailable(): string {
  const repoPath = getComputerUseMcpRepoPath();
  try {
    if (!statSync(repoPath).isDirectory()) {
      throw new Error(`Computer use MCP repo is not a directory: ${repoPath}`);
    }
  } catch {
    throw new Error(
      `Computer use MCP repo not found at ${repoPath}. Set COMPUTER_USE_MCP_REPO if needed.`,
    );
  }

  const serverPath = getComputerUseMcpServerPath();
  try {
    if (!statSync(serverPath).isFile()) {
      throw new Error(`Computer use MCP server is not a file: ${serverPath}`);
    }
  } catch {
    throw new Error(
      `Computer use MCP server not found at ${serverPath}. Finish computer-use-mcp first.`,
    );
  }

  return serverPath;
}

async function requestComputerUse<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getComputerUseHostUrl();
  if (!baseUrl) {
    throw new Error('COMPUTER_USE_HOST_URL is not configured.');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `Computer use request failed with ${response.status}`);
  }

  return payload as T;
}

async function ensureComputerUseSession(
  statePath: string,
  state: BotState,
  chatState: StoredChatState,
  label: string,
): Promise<{ sessionId: string; created: boolean }> {
  await ensureComputerUseHostAvailable();

  if (chatState.computerUseSessionId) {
    try {
      const existing = await requestComputerUse<ComputerUseSessionResponse>(
        `/sessions/${chatState.computerUseSessionId}`,
      );
      return { sessionId: existing.session.id, created: false };
    } catch {
      // Fall through and replace stale session ids.
    }
  }

  const response = await requestComputerUse<ComputerUseSessionResponse>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ label }),
  });

  chatState.computerUseSessionId = response.session.id;
  saveState(statePath, state);
  return { sessionId: response.session.id, created: true };
}

async function prepareComputerUseCodexContext(
  statePath: string,
  state: BotState,
  chatState: StoredChatState,
  chatId: number,
): Promise<{
  sessionId?: string;
  instructions?: string;
  status: string;
}> {
  try {
    const mcpStatus = await ensureComputerUseMcpRegistered();
    const session = await ensureComputerUseSession(
      statePath,
      state,
      chatState,
      `telegram-chat-${chatId}`,
    );

    const mcpSummary = mcpStatus === 'unchanged'
      ? 'MCP ready'
      : mcpStatus === 'registered'
        ? 'MCP registered'
        : 'MCP updated';
    const sessionSummary = session.created
      ? `created session ${session.sessionId}`
      : `using session ${session.sessionId}`;

    return {
      sessionId: session.sessionId,
      instructions: buildComputerUseCodexInstructions(session.sessionId),
      status: `Computer-use ${mcpSummary}; ${sessionSummary}.`,
    };
  } catch (error: any) {
    return {
      status: `Computer-use MCP unavailable: ${error.message}`,
    };
  }
}

async function getCodexMcpServer(
  cwd: string,
  name: string,
): Promise<CodexMcpServerConfig | null> {
  try {
    const output = await runCliTool('codex', ['mcp', 'get', name, '--json'], cwd, 30_000);
    return JSON.parse(output) as CodexMcpServerConfig;
  } catch (error: any) {
    if (error.message.includes(`No MCP server named '${name}' found.`)) {
      return null;
    }
    throw error;
  }
}

async function ensureComputerUseMcpRegistered(): Promise<'registered' | 'updated' | 'unchanged'> {
  const hostUrl = getComputerUseHostUrl();
  if (!hostUrl) {
    throw new Error('COMPUTER_USE_HOST_URL is not configured.');
  }

  const serverPath = ensureComputerUseMcpFilesAvailable();
  const codexConfigCwd = getCodexConfigCwd();
  const existing = await getCodexMcpServer(codexConfigCwd, COMPUTER_USE_MCP_SERVER_NAME);
  if (existing && isExpectedComputerUseMcpServer(existing, serverPath, hostUrl)) {
    return 'unchanged';
  }

  if (existing) {
    await runCliTool('codex', ['mcp', 'remove', COMPUTER_USE_MCP_SERVER_NAME], codexConfigCwd, 30_000);
  }

  await runCliTool('codex', buildCodexMcpAddArgs(serverPath, hostUrl), codexConfigCwd, 30_000);
  return existing ? 'updated' : 'registered';
}

async function sendComputerUseScreenshot(
  bot: TelegramBot,
  chatId: number,
  sessionId: string,
  prefix?: string,
): Promise<void> {
  await ensureComputerUseHostAvailable();

  const result = await requestComputerUse<ComputerUseScreenshotResult>(
    `/sessions/${sessionId}/actions/screenshot`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );

  const baseCaption = buildComputerUseScreenshotCaption(
    result.session_id,
    result.summary,
    result.state.frontmost_app,
  );
  const caption = prefix ? `${prefix}\n${baseCaption}` : baseCaption;

  try {
    await bot.sendPhoto(
      chatId,
      result.artifact.path,
      { caption },
      buildTelegramFileOptions(result.artifact.path),
    );
  } catch {
    await bot.sendDocument(
      chatId,
      result.artifact.path,
      { caption },
      buildTelegramFileOptions(result.artifact.path),
    );
  }
}

async function sendComputerUseRecording(
  bot: TelegramBot,
  chatId: number,
  result: ComputerUseRecordingStopResult,
): Promise<void> {
  const caption = buildComputerUseRecordingCaption(result.session_id, result.summary);
  try {
    await bot.sendVideo(
      chatId,
      result.artifact.path,
      { caption },
      buildTelegramFileOptions(result.artifact.path),
    );
  } catch {
    await bot.sendDocument(
      chatId,
      result.artifact.path,
      { caption },
      buildTelegramFileOptions(result.artifact.path),
    );
  }
}

async function sendComputerUseState(
  bot: TelegramBot,
  chatId: number,
  sessionId: string,
): Promise<void> {
  await ensureComputerUseHostAvailable();
  const result = await requestComputerUse<ComputerUseStateResponse>(
    `/sessions/${sessionId}/state`,
  );
  await bot.sendMessage(
    chatId,
    buildComputerUseStateSummary(result.session_id, result.summary, result.state),
  );
}

async function sendComputerUseArtifacts(
  bot: TelegramBot,
  chatId: number,
  sessionId: string,
): Promise<void> {
  await ensureComputerUseHostAvailable();
  const result = await requestComputerUse<ComputerUseArtifactsResponse>(
    `/sessions/${sessionId}/artifacts`,
  );
  await bot.sendMessage(
    chatId,
    buildComputerUseArtifactsSummary(result.session_id, result.summary, result.artifacts),
  );
}

async function captureComputerUseScreenshotArtifact(
  sessionId: string,
): Promise<ComputerUseScreenshotResult> {
  await ensureComputerUseHostAvailable();
  return requestComputerUse<ComputerUseScreenshotResult>(
    `/sessions/${sessionId}/actions/screenshot`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}

function parseAutonomousTaskTurnResult(raw: string): AutonomousTaskTurnResult {
  const parsed = JSON.parse(raw) as Partial<AutonomousTaskTurnResult>;
  if (
    (parsed.status !== 'completed' && parsed.status !== 'continue' && parsed.status !== 'blocked')
    || typeof parsed.summary !== 'string'
    || parsed.summary.trim() === ''
    || typeof parsed.evidence !== 'string'
    || parsed.evidence.trim() === ''
    || (parsed.phase != null
      && parsed.phase !== 'red'
      && parsed.phase !== 'green'
      && parsed.phase !== 'refactor'
      && parsed.phase !== 'verify')
    || (parsed.tests_ran != null && typeof parsed.tests_ran !== 'string')
  ) {
    throw new Error('Codex returned an invalid autonomous task result.');
  }

  return {
    status: parsed.status,
    summary: parsed.summary.trim(),
    evidence: parsed.evidence.trim(),
    phase: parsed.phase,
    tests_ran: typeof parsed.tests_ran === 'string' && parsed.tests_ran.trim()
      ? parsed.tests_ran.trim()
      : undefined,
    next_focus: typeof parsed.next_focus === 'string' && parsed.next_focus.trim()
      ? parsed.next_focus.trim()
      : undefined,
  };
}

// --- Command runner ---

interface CommandHandle {
  proc: ChildProcess;
  kill: () => void;
  promise: Promise<{ killed: boolean; stdout: string; stderr: string; error?: string }>;
}

function spawnCommandHandle(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): CommandHandle {
  const fullCommand = [command, ...args].map(shellQuote).join(' ');
  const proc = spawn('/bin/zsh', ['-li', '-c', fullCommand], { cwd });
  let killed = false;

  const kill = () => {
    killed = true;
    proc.kill('SIGTERM');
  };

  const promise = new Promise<{ killed: boolean; stdout: string; stderr: string; error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      kill();
      resolve({
        killed: false,
        stdout: '',
        stderr: '',
        error: `Command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => {
      const line = data.toString();
      if (!line.includes('no stdin data received')) {
        stderr += line;
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ killed: true, stdout, stderr });
        return;
      }

      if (code === 0) {
        resolve({ killed: false, stdout, stderr });
        return;
      }

      const output = (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim();
      resolve({
        killed: false,
        stdout,
        stderr,
        error: output || `Process exited with code ${code}`,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        killed: false,
        stdout,
        stderr,
        error: err.message,
      });
    });
  });

  return { proc, kill, promise };
}

function runCliTool(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const handle = spawnCommandHandle(command, args, cwd, timeoutMs);
    handle.promise.then((outcome) => {
      if (outcome.killed) {
        reject(new Error('Command interrupted.'));
        return;
      }

      if (outcome.error) {
        reject(new Error(outcome.error));
        return;
      }

      const output = (
        outcome.stdout + (outcome.stderr ? '\nSTDERR:\n' + outcome.stderr : '')
      ).trim();
      resolve(output);
    });
  });
}

// --- Streaming CLI runner for chat mode ---

function formatUsageStats(usage: Record<string, any> | undefined): string | undefined {
  if (!usage) return undefined;

  const input = (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cached_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;

  if (!input && !output) return undefined;
  return `${input.toLocaleString()} in / ${output.toLocaleString()} out`;
}

interface StreamParser {
  processLine: (line: string, events: EventEmitter) => void;
  finalize: (
    code: number | null,
    stdout: string,
    stderr: string,
  ) => { result?: CliResult; error?: string };
}

interface StreamingHandle {
  proc: ChildProcess;
  events: EventEmitter;  // emits 'text', 'thinking', 'sessionId'
  kill: () => void;
  promise: Promise<{ killed: boolean; result?: CliResult; error?: string }>;
}

function createClaudeStreamParser(): StreamParser {
  let accText = '';
  let accThinking = '';
  let resultJson: any = null;

  return {
    processLine(line, events) {
      try {
        const json = JSON.parse(line);

        if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
          const t = json.content_block.thinking ?? '';
          accThinking += t;
          if (t) events.emit('thinking', t);
        }
        if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') {
          const t = json.delta.thinking ?? '';
          accThinking += t;
          if (t) events.emit('thinking', t);
        }
        if (json.type === 'content_block_start' && json.content_block?.type === 'text') {
          const t = json.content_block.text ?? '';
          accText += t;
          if (t) events.emit('text', t);
        }
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          const t = json.delta.text ?? '';
          accText += t;
          if (t) events.emit('text', t);
        }
        if (json.type === 'result' && typeof json.result === 'string') {
          resultJson = json;
        }
      } catch {}
    },
    finalize(code, stdout, stderr) {
      if (resultJson) {
        const parts: string[] = [];
        const usageStats = formatUsageStats(resultJson.usage);
        if (usageStats) parts.push(usageStats);
        if (resultJson.duration_ms != null) {
          parts.push(`${(resultJson.duration_ms / 1000).toFixed(1)}s`);
        }
        return {
          result: {
            text: resultJson.result,
            stats: parts.length > 0 ? parts.join(' | ') : undefined,
            thinking: accThinking || undefined,
          },
        };
      }

      if (code === 0) {
        return { result: { text: accText || stdout.trim() } };
      }

      const output = (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim();
      return { error: output || `Process exited with code ${code}` };
    },
  };
}

function createCodexStreamParser(): StreamParser {
  let text = '';
  let stats: string | undefined;

  return {
    processLine(line, events) {
      try {
        const json = JSON.parse(line);

        if (json.type === 'thread.started' && typeof json.thread_id === 'string') {
          events.emit('sessionId', json.thread_id);
        }

        if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
          const nextText = json.item.text ?? '';
          if (typeof nextText === 'string' && nextText) {
            text = text ? `${text}\n\n${nextText}` : nextText;
            events.emit('text', text);
          }
        }

        if (json.type === 'turn.completed') {
          stats = formatUsageStats(json.usage);
        }
      } catch {}
    },
    finalize(code, stdout, stderr) {
      if (code === 0) {
        return {
          result: {
            text,
            stats,
          },
        };
      }

      const output = stderr.trim() || stdout.trim();
      return { error: output || `Process exited with code ${code}` };
    },
  };
}

function spawnStreamingCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  provider: ChatProvider,
  transcriptPath?: string,
): StreamingHandle {
  const fullCommand = [command, ...args].map(shellQuote).join(' ');
  const proc = spawn('/bin/zsh', ['-li', '-c', fullCommand], { cwd });
  const events = new EventEmitter();
  const parser = provider === 'codex'
    ? createCodexStreamParser()
    : createClaudeStreamParser();
  let killed = false;

  const kill = () => {
    killed = true;
    proc.kill('SIGTERM');
  };

  const promise = new Promise<{ killed: boolean; result?: CliResult; error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      kill();
      resolve({ killed: false, error: `Command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (transcriptPath) {
        appendChatTranscript(transcriptPath, chunk);
      }
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) parser.processLine(line.trim(), events);
      }
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString();
      if (!line.includes('no stdin data received')) {
        stderr += line;
        if (transcriptPath) {
          appendChatTranscript(transcriptPath, `\n[stderr]\n${line}`);
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Process any remaining buffered line
      if (lineBuffer.trim()) parser.processLine(lineBuffer.trim(), events);

      if (killed) {
        resolve({ killed: true });
        return;
      }

      resolve({ killed: false, ...parser.finalize(code, stdout, stderr) });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ killed: false, error: err.message });
    });
  });

  return { proc, events, kill, promise };
}

// --- Streaming Telegram message updater ---

const STREAM_UPDATE_INTERVAL_MS = 2000;
const TELEGRAM_MAX_LENGTH = 4096;

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_LENGTH - 20) return text;
  return text.slice(text.length - TELEGRAM_MAX_LENGTH + 40) + '\n[...truncated]';
}

// --- CLI output parser ---

interface CliResult {
  text: string;
  stats?: string;
  thinking?: string;
}

export function parseCliOutput(raw: string): CliResult {
  const lines = raw.split('\n').filter(l => l.trim());

  let resultJson: any = null;
  let thinking = '';
  let codexText = '';
  let codexStats: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      // Accumulate thinking from stream-json content blocks
      if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
        thinking += json.content_block.thinking ?? '';
      }
      if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') {
        thinking += json.delta.thinking ?? '';
      }

      // Capture the result line (works for both json and stream-json)
      if (json.type === 'result' && typeof json.result === 'string') {
        resultJson = json;
      }

      if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
        const nextText = json.item.text ?? '';
        if (typeof nextText === 'string' && nextText) {
          codexText = codexText ? `${codexText}\n\n${nextText}` : nextText;
        }
      }

      if (json.type === 'turn.completed') {
        codexStats = formatUsageStats(json.usage);
      }
    } catch {}
  }

  if (resultJson) {
    const parts: string[] = [];
    const usageStats = formatUsageStats(resultJson.usage);
    if (usageStats) parts.push(usageStats);
    if (resultJson.duration_ms != null) {
      parts.push(`${(resultJson.duration_ms / 1000).toFixed(1)}s`);
    }
    return {
      text: resultJson.result,
      stats: parts.length > 0 ? parts.join(' | ') : undefined,
      thinking: thinking || undefined,
    };
  }

  if (codexText || codexStats) {
    return {
      text: codexText || raw,
      stats: codexStats,
    };
  }

  return { text: raw };
}

// --- Output sender ---

async function sendFormatted(
  bot: TelegramBot,
  chatId: number,
  output: FormattedOutput,
  stats?: string,
): Promise<void> {
  if (output.type === 'text') {
    const message = stats ? `${output.content}\n\n${stats}` : output.content;
    await bot.sendMessage(chatId, message);
  } else {
    const filePath = join(tmpdir(), `output-${Date.now()}.txt`);
    writeFileSync(filePath, output.content);
    const caption = stats
      ? `Output sent as file.\n${stats}`
      : 'Output exceeded 4096 chars — sent as file.';
    await bot.sendDocument(chatId, filePath, { caption }, buildTelegramFileOptions(filePath));
  }
}

async function sendCliResult(
  bot: TelegramBot,
  chatId: number,
  parsed: CliResult,
): Promise<void> {
  if (parsed.thinking) {
    const thinkingFormatted = formatOutput(parsed.thinking);
    if (thinkingFormatted.type === 'text') {
      await bot.sendMessage(chatId, `Thinking:\n${thinkingFormatted.content}`);
    } else {
      const filePath = join(tmpdir(), `thinking-${Date.now()}.txt`);
      writeFileSync(filePath, thinkingFormatted.content);
      await bot.sendDocument(
        chatId,
        filePath,
        { caption: 'Thinking' },
        buildTelegramFileOptions(filePath),
      );
    }
  }
  const formatted = formatOutput(parsed.text);
  await sendFormatted(bot, chatId, formatted, parsed.stats);
}

// --- Bot setup ---

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  if (allowedUsers.length === 0) {
    console.error('TELEGRAM_ALLOWED_USERS is required');
    process.exit(1);
  }

  const config = loadConfig(join(import.meta.dirname, '..', 'config.json'));
  const statePath = join(import.meta.dirname, '..', 'state.json');
  const state = loadState(statePath);
  const defaultProject = state.defaultCurrentProject || config.default_project;

  function getChatState(chatId: number): StoredChatState {
    const key = String(chatId);
    const existing = state.chatStates[key];
    if (existing) {
      return existing;
    }

    const chatState: StoredChatState = {
      ...DEFAULT_CHAT_STATE,
      currentProject: defaultProject,
    };
    state.chatStates[key] = chatState;
    saveState(statePath, state);
    return chatState;
  }

  function getCurrentProject(chatId: number): string {
    return getChatState(chatId).currentProject || config.default_project;
  }

  const bot = new TelegramBot(token, {
    polling: {
      params: state.lastUpdateId > 0
        ? { offset: state.lastUpdateId + 1 }
        : undefined,
    },
  });

  const origProcessUpdate = bot.processUpdate.bind(bot);
  (bot as any).processUpdate = (update: TelegramBot.Update) => {
    origProcessUpdate(update);
    if (update.update_id > state.lastUpdateId) {
      state.lastUpdateId = update.update_id;
      saveState(statePath, state);
    }
  };

  let lastPollingDiagnosticAt = 0;
  bot.on('polling_error', async (error: any) => {
    const message = error?.message ?? String(error);
    console.error(`[telegram] polling error: ${message}`);

    const now = Date.now();
    if ((now - lastPollingDiagnosticAt) < TELEGRAM_POLLING_DIAGNOSTIC_INTERVAL_MS) {
      return;
    }
    lastPollingDiagnosticAt = now;

    try {
      const diagnostics = await getTelegramConnectivityDiagnostics();
      console.error(`[telegram] ${diagnostics.summary}`);
      console.error(`[telegram] ${formatTelegramHostLookup(diagnostics.telegramDns)}`);
      console.error(`[telegram] ${formatTelegramHostLookup(diagnostics.generalDns)}`);
      console.error(`[telegram] ${formatTelegramUrlCheck(diagnostics.telegramHttps)}`);
    } catch (diagnosticError: any) {
      console.error(
        `[telegram] failed to collect connectivity diagnostics: ${diagnosticError?.message ?? diagnosticError}`,
      );
    }
  });

  // Register commands with Telegram's autocomplete menu
  const botCommands: TelegramBot.BotCommand[] = [
    ...Object.entries(config.cli_tools).map(([name, tool]) => ({
      command: name,
      description: tool.description,
    })),
    { command: 'claudechat', description: 'Start interactive Claude chat' },
    { command: 'claudechatyolo', description: 'Start Claude chat (skip permissions)' },
    { command: 'codexchat', description: 'Start interactive Codex chat' },
    { command: 'codexchatyolo', description: 'Start Codex chat (full auto)' },
    { command: 'chatterminal', description: 'Open local Terminal transcript for the active chat' },
    { command: 'endchat', description: 'End chat session' },
    { command: 'run', description: 'Run a shell command' },
    { command: 'status', description: 'System status' },
    { command: 'projects', description: 'List project directories' },
    { command: 'cd', description: 'Set working directory' },
    { command: 'sessionstart', description: 'Start a computer-use session' },
    { command: 'sessionstate', description: 'Show computer-use session state' },
    { command: 'sessionscreenshot', description: 'Capture a computer-use screenshot' },
    { command: 'sessionartifacts', description: 'List computer-use artifacts' },
    { command: 'sessionlaunch', description: 'Launch an app in the session' },
    { command: 'sessionwatchon', description: 'Start periodic computer-use screenshots' },
    { command: 'sessionwatchoff', description: 'Stop periodic computer-use screenshots' },
    { command: 'sessionrecordstart', description: 'Start computer-use screen recording' },
    { command: 'sessionrecordstop', description: 'Stop computer-use screen recording' },
    { command: 'task', description: 'Run an autonomous Codex task' },
    { command: 'taskovernight', description: 'Run an overnight TDD Codex task loop' },
    { command: 'taskstatus', description: 'Show autonomous task status' },
    { command: 'taskstop', description: 'Stop the active autonomous task' },
    { command: 'telegramsendphotojs', description: 'Get Telegram Web photo-send bookmarklet' },
    { command: 'remote', description: 'Start Claude remote control session' },
    { command: 'endremote', description: 'Stop remote control session' },
    { command: 'help', description: 'List commands' },
    { command: 'restart', description: 'Restart the bot' },
  ];
  await bot.setMyCommands(botCommands);

  console.log(`Bot started. Allowed users: ${JSON.stringify(allowedUsers)}`);
  console.log('Listening for messages...');

  const startupDiagnostics = await getComputerUseStartupDiagnostics();
  startupDiagnostics.forEach((line) => {
    console.log(`[computer-use] ${line}`);
  });

  let computerUseStartupError: string | null = null;
  if (getComputerUseHostUrl() && shouldAutostartComputerUseHost()) {
    try {
      await ensureComputerUseHostAvailable();
      console.log('Computer-use host is ready.');
    } catch (error: any) {
      computerUseStartupError = error.message;
      console.warn(`Computer-use host autostart failed: ${error.message}`);
    }
  }

  // Notify allowed users that the bot has started
  const now = Date.now();
  const STARTUP_COOLDOWN_MS = 30_000;
  const suppressStartupMsg = (now - state.lastStartTime) < STARTUP_COOLDOWN_MS;
  const hadInterruptedChats = state.legacyChatActive
    || Object.values(state.chatStates).some((chatState) => chatState.chatActive);

  state.lastStartTime = now;
  state.legacyChatActive = false;
  Object.values(state.chatStates).forEach((chatState) => {
    chatState.chatActive = false;
  });
  saveState(statePath, state);

  if (!suppressStartupMsg) {
    for (const userId of allowedUsers) {
      bot.sendMessage(userId, `Bot started. Default CWD: ${basename(defaultProject)}`).catch((err: any) => {
        console.error(`Failed to send startup message to ${userId}: ${err.message}`);
      });
    }
    if (hadInterruptedChats) {
      for (const userId of allowedUsers) {
        bot.sendMessage(userId, 'Previous chat sessions were interrupted by restart.').catch(() => {});
      }
    }

    if (getComputerUseHostUrl()) {
      const diagnosticLines = [
        'Computer-use startup diagnostic:',
        ...startupDiagnostics.map((line) => `- ${line}`),
      ];
      if (computerUseStartupError) {
        diagnosticLines.push(`- Autostart result: failed (${computerUseStartupError})`);
      } else if (shouldAutostartComputerUseHost()) {
        diagnosticLines.push('- Autostart result: host ready');
      }

      for (const userId of allowedUsers) {
        bot.sendMessage(userId, diagnosticLines.join('\n')).catch(() => {});
      }
    }
  } else {
    console.log('Startup message suppressed (cooldown)');
  }

  // Log all incoming messages
  bot.on('message', (msg) => {
    console.log(`Message from ${msg.from?.id} (${msg.from?.username}): ${msg.text}`);
  });

  // Auth guard — wraps every handler
  function authed(
    handler: (msg: TelegramBot.Message, match: RegExpExecArray | null) => void,
  ) {
    return (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
      if (!msg.from || !isAllowedUser(msg.from.id, allowedUsers)) {
        console.log(`Rejected: user ${msg.from?.id} not in allowlist`);
        return;
      }
      handler(msg, match);
    };
  }

  const watchIntervals = new Map<number, ReturnType<typeof setInterval>>();
  const pendingGuidedActions = new Map<number, GuidedAction>();

  async function sendMenuMessage(chatId: number, text: string): Promise<void> {
    await bot.sendMessage(chatId, text, {
      reply_markup: buildMainReplyKeyboard(),
    });
  }

  function setPendingGuidedAction(chatId: number, action: GuidedAction): void {
    pendingGuidedActions.set(chatId, action);
  }

  function clearPendingGuidedAction(chatId: number): void {
    pendingGuidedActions.delete(chatId);
  }

  async function sendStatusMessage(chatId: number): Promise<void> {
    const currentProject = getCurrentProject(chatId);
    const uptime = await execAsync('uptime');
    const battery = await execAsync(
      'pmset -g batt | grep -Eo "\\d+%"',
    ).catch(() => ({ stdout: 'N/A' }));

    const text = [
      '🟢 Online',
      `Uptime: ${uptime.stdout.trim()}`,
      `Battery: ${battery.stdout.trim()}`,
      `CWD: ${currentProject}`,
    ].join('\n');

    await sendMenuMessage(chatId, text);
  }

  async function sendProjectsMessage(chatId: number): Promise<void> {
    const currentProject = getCurrentProject(chatId);
    const list = config.projects
      .map((p, i) => {
        const marker = p === currentProject ? ' ← current' : '';
        return `${i + 1}. ${basename(p)}${marker}`;
      })
      .join('\n');

    await sendMenuMessage(chatId, list || 'No projects configured.');
  }

  async function startTaskFromGoal(chatId: number, goal: string, mode: TaskMode = 'standard'): Promise<void> {
    const existingTask = taskRuns.get(chatId);
    if (existingTask) {
      await sendMenuMessage(chatId, `A task is already running.\n${buildAutonomousTaskStatusSummary(existingTask.task)}`);
      return;
    }

    if (chatSessions.get(chatId)) {
      await sendMenuMessage(chatId, 'End the active chat session before starting an autonomous task.');
      return;
    }

    let taskTool: { key: string; tool: CliTool };
    try {
      taskTool = getTaskTool();
    } catch (error: any) {
      await sendMenuMessage(chatId, `Error: ${error.message}`);
      return;
    }

    const currentProject = getCurrentProject(chatId);
    const chatState = getChatState(chatId);
    const context = await prepareComputerUseCodexContext(
      statePath,
      state,
      chatState,
      chatId,
    );
    const maxRuntimeMs = getAutonomousTaskMaxRuntimeMs(mode);

    const task: StoredTaskState = {
      id: `task-${Date.now()}`,
      goal,
      status: 'running',
      mode,
      attempt: 0,
      maxAttempts: getAutonomousTaskMaxAttempts(mode),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentProject,
      deadlineAt: maxRuntimeMs
        ? new Date(Date.now() + maxRuntimeMs).toISOString()
        : undefined,
    };
    updateTaskState(chatId, task);

    const taskRun: TaskRun = {
      task,
      stopRequested: false,
      recentMemoryEntries: [],
    };
    taskRuns.set(chatId, taskRun);

    const lines = [
      `Autonomous task started with ${taskTool.key} in ${basename(currentProject)}.`,
      `Goal: ${goal}`,
      `Mode: ${mode === 'overnight' ? 'overnight TDD loop' : 'standard'}`,
      `Retry budget: ${task.maxAttempts}`,
      ...(task.deadlineAt ? [`Deadline: ${task.deadlineAt}`] : []),
      context.status,
    ];
    await sendMenuMessage(chatId, lines.join('\n'));

    taskRun.promise = runAutonomousTask(chatId, taskRun).catch(async (error: any) => {
      taskRun.task.status = 'failed';
      taskRun.task.updatedAt = new Date().toISOString();
      taskRun.task.lastSummary = error.message;
      updateTaskState(chatId, taskRun.task);
      taskRuns.delete(chatId);
      await sendMenuMessage(
        chatId,
        `Task failed.\n${buildAutonomousTaskStatusSummary(taskRun.task)}`,
      );
    });
  }

  async function launchAppInSession(chatId: number, appName: string): Promise<void> {
    const sessionId = getChatState(chatId).computerUseSessionId;
    if (!sessionId) {
      await sendMenuMessage(chatId, 'No active computer-use session. Use /sessionstart first.');
      return;
    }

    await ensureComputerUseHostAvailable();
    const result = await requestComputerUse<ComputerUseLaunchAppResult>(
      `/sessions/${sessionId}/actions/launch-app`,
      {
        method: 'POST',
        body: JSON.stringify({ app_name: appName }),
      },
    );

    const lines = [
      `Session: ${result.session_id}`,
      result.summary,
    ];
    if (result.state.frontmost_app) {
      lines.push(`Frontmost app: ${result.state.frontmost_app}`);
    }
    await sendMenuMessage(chatId, lines.join('\n'));
  }

  async function changeProjectForChat(chatId: number, arg: string): Promise<void> {
    const project = parseProjectArg(arg, config.projects);
    if (!project) {
      await sendMenuMessage(
        chatId,
        `Project not found: "${arg}". Use /projects to see available options.`,
      );
      return;
    }

    const chatState = getChatState(chatId);
    chatState.currentProject = project;
    saveState(statePath, state);
    await sendMenuMessage(chatId, `Working directory: ${project}`);
  }

  function stopSessionWatch(chatId: number): void {
    const interval = watchIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      watchIntervals.delete(chatId);
    }
  }

  function startSessionWatch(chatId: number, sessionId: string): void {
    stopSessionWatch(chatId);
    const intervalMs = getComputerUseWatchIntervalMs();

    const interval = setInterval(() => {
      void sendComputerUseScreenshot(
        bot,
        chatId,
        sessionId,
        'Watch update',
      ).catch(async (error: any) => {
        stopSessionWatch(chatId);
        if (!watchIntervals.has(chatId)) {
          await bot.sendMessage(chatId, `Watch stopped: ${error.message}`);
        }
      });
    }, intervalMs);

    watchIntervals.set(chatId, interval);
  }

  interface TaskRun {
    task: StoredTaskState;
    stopRequested: boolean;
    activeHandle?: CommandHandle;
    promise?: Promise<void>;
    compactMemory?: string;
    recentMemoryEntries: string[];
  }

  const taskRuns = new Map<number, TaskRun>();

  function getTaskTool(): { key: string; tool: CliTool } {
    const preferredKey = config.cli_tools.codexyolo ? 'codexyolo' : 'codex';
    const tool = config.cli_tools[preferredKey];
    if (!tool || tool.command !== 'codex') {
      throw new Error('An autonomous task requires a configured Codex CLI tool.');
    }
    return { key: preferredKey, tool };
  }

  function updateTaskState(chatId: number, nextTask?: StoredTaskState): void {
    const chatState = getChatState(chatId);
    if (nextTask) {
      chatState.task = nextTask;
    } else {
      delete chatState.task;
    }
    saveState(statePath, state);
  }

  async function runAutonomousTaskAttempt(
    currentProject: string,
    tool: CliTool,
    prompt: string,
    taskId: string,
    attempt: number,
    imagePath?: string,
  ): Promise<{ handle: CommandHandle; readResult: () => AutonomousTaskTurnResult }> {
    const schemaPath = join(tmpdir(), `${taskId}-attempt-${attempt}-schema.json`);
    const outputPath = join(tmpdir(), `${taskId}-attempt-${attempt}-result.json`);
    writeFileSync(schemaPath, JSON.stringify(buildAutonomousTaskSchema(), null, 2));

    const args = [
      'exec',
      ...normalizeCodexToolArgs(tool.args),
      CODEX_SKIP_GIT_REPO_CHECK_ARG,
      ...(imagePath ? ['-i', imagePath] : []),
      '--output-schema',
      schemaPath,
      '-o',
      outputPath,
      prompt,
    ];

    const handle = spawnCommandHandle('codex', args, currentProject, config.command_timeout_ms);
    return {
      handle,
      readResult: () => parseAutonomousTaskTurnResult(readFileSync(outputPath, 'utf-8')),
    };
  }

  async function runAutonomousTask(chatId: number, taskRun: TaskRun): Promise<void> {
    const { tool } = getTaskTool();
    let previousSummary: string | undefined;

    try {
      for (let attempt = taskRun.task.attempt + 1; attempt <= taskRun.task.maxAttempts; attempt += 1) {
        if (taskRun.stopRequested) {
          taskRun.task.status = 'stopped';
          taskRun.task.updatedAt = new Date().toISOString();
          taskRun.task.lastSummary = 'Stopped by user.';
          updateTaskState(chatId, taskRun.task);
          await bot.sendMessage(chatId, buildAutonomousTaskStatusSummary(taskRun.task));
          return;
        }

        if (taskRun.task.deadlineAt && Date.now() >= Date.parse(taskRun.task.deadlineAt)) {
          taskRun.task.status = 'exhausted';
          taskRun.task.updatedAt = new Date().toISOString();
          taskRun.task.lastSummary = 'Overnight runtime budget reached.';
          updateTaskState(chatId, taskRun.task);
          await bot.sendMessage(
            chatId,
            `Task stopped after reaching the runtime budget.\n${buildAutonomousTaskStatusSummary(taskRun.task)}`,
          );
          return;
        }

        taskRun.task.attempt = attempt;
        taskRun.task.updatedAt = new Date().toISOString();
        updateTaskState(chatId, taskRun.task);

        let screenshotPath: string | undefined;
        const sessionId = getChatState(chatId).computerUseSessionId;
        if (sessionId) {
          try {
            const screenshot = await captureComputerUseScreenshotArtifact(sessionId);
            screenshotPath = screenshot.artifact.path;
          } catch {
            screenshotPath = undefined;
          }
        }

        await bot.sendMessage(
          chatId,
          `Task attempt ${attempt}/${taskRun.task.maxAttempts} running in ${basename(taskRun.task.currentProject)}...`,
        );

        const prompt = buildAutonomousTaskPrompt(
          taskRun.task.goal,
          taskRun.task.currentProject,
          attempt,
          taskRun.task.maxAttempts,
          {
            mode: taskRun.task.mode ?? 'standard',
            phase: taskRun.task.phase,
            memory: buildAutonomousTaskMemory(taskRun.compactMemory, taskRun.recentMemoryEntries),
            previousSummary,
            sessionId,
          },
        );

        const attemptRun = await runAutonomousTaskAttempt(
          taskRun.task.currentProject,
          tool,
          prompt,
          taskRun.task.id,
          attempt,
          screenshotPath,
        );
        taskRun.activeHandle = attemptRun.handle;
        const outcome = await attemptRun.handle.promise;
        taskRun.activeHandle = undefined;

        if (outcome.killed) {
          taskRun.task.status = taskRun.stopRequested ? 'stopped' : 'failed';
          taskRun.task.updatedAt = new Date().toISOString();
          taskRun.task.lastSummary = taskRun.stopRequested ? 'Stopped by user.' : 'Task interrupted.';
          updateTaskState(chatId, taskRun.task);
          await bot.sendMessage(chatId, buildAutonomousTaskStatusSummary(taskRun.task));
          return;
        }

        if (outcome.error) {
          taskRun.task.status = 'failed';
          taskRun.task.updatedAt = new Date().toISOString();
          taskRun.task.lastSummary = outcome.error;
          updateTaskState(chatId, taskRun.task);
          await bot.sendMessage(chatId, `Task failed.\n${buildAutonomousTaskStatusSummary(taskRun.task)}`);
          return;
        }

        const result = attemptRun.readResult();
        previousSummary = [
          `Summary: ${result.summary}`,
          `Evidence: ${result.evidence}`,
          ...(result.tests_ran ? [`Tests: ${result.tests_ran}`] : []),
          ...(result.next_focus ? [`Next focus: ${result.next_focus}`] : []),
        ].join('\n');

        taskRun.task.updatedAt = new Date().toISOString();
        taskRun.task.lastSummary = result.summary;
        taskRun.task.phase = result.phase ?? taskRun.task.phase;

        const memoryEntry = formatAutonomousTaskMemoryEntry(attempt, result);
        if (taskRun.recentMemoryEntries.length >= AUTONOMOUS_TASK_RECENT_MEMORY_ENTRIES) {
          const shifted = taskRun.recentMemoryEntries.shift();
          if (shifted) {
            taskRun.compactMemory = appendCompactedMemory(
              taskRun.compactMemory,
              shifted,
              AUTONOMOUS_TASK_MEMORY_MAX_CHARS,
            );
          }
        }
        taskRun.recentMemoryEntries.push(memoryEntry);

        const latestSessionId = getChatState(chatId).computerUseSessionId;
        if (latestSessionId) {
          try {
            await sendComputerUseScreenshot(
              bot,
              chatId,
              latestSessionId,
              `Task attempt ${attempt} snapshot`,
            );
          } catch {}
        }

        if (result.status === 'completed') {
          taskRun.task.status = 'completed';
          updateTaskState(chatId, taskRun.task);
          await bot.sendMessage(
            chatId,
            `Task completed.\n${buildAutonomousTaskStatusSummary(taskRun.task)}\nVerification: ${result.evidence}${result.tests_ran ? `\nTests: ${result.tests_ran}` : ''}`,
          );
          return;
        }

        if (result.status === 'blocked') {
          taskRun.task.status = 'blocked';
          updateTaskState(chatId, taskRun.task);
          await bot.sendMessage(
            chatId,
            `Task blocked.\n${buildAutonomousTaskStatusSummary(taskRun.task)}\nEvidence: ${result.evidence}${result.tests_ran ? `\nTests: ${result.tests_ran}` : ''}${result.next_focus ? `\nBlocker: ${result.next_focus}` : ''}`,
          );
          return;
        }

        await bot.sendMessage(
          chatId,
          `Task continuing after attempt ${attempt}/${taskRun.task.maxAttempts}.${result.phase ? `\nPhase: ${result.phase}` : ''}\nSummary: ${result.summary}${result.tests_ran ? `\nTests: ${result.tests_ran}` : ''}${result.next_focus ? `\nNext focus: ${result.next_focus}` : ''}`,
        );
      }

      taskRun.task.status = 'exhausted';
      taskRun.task.updatedAt = new Date().toISOString();
      taskRun.task.lastSummary = taskRun.task.lastSummary ?? 'Retry budget exhausted.';
      updateTaskState(chatId, taskRun.task);
      await bot.sendMessage(
        chatId,
        `Task stopped after reaching the retry budget.\n${buildAutonomousTaskStatusSummary(taskRun.task)}`,
      );
    } finally {
      taskRun.activeHandle = undefined;
      taskRuns.delete(chatId);
    }
  }

  // --- /status ---
  bot.onText(
    /^\/status/,
    authed(async (msg) => {
      try {
        await sendStatusMessage(msg.chat.id);
      } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err}`);
      }
    }),
  );

  // --- /projects ---
  bot.onText(
    /^\/projects/,
    authed(async (msg) => {
      await sendProjectsMessage(msg.chat.id);
    }),
  );

  // --- /cd ---
  bot.onText(
    /^\/cd\s+(.+)/,
    authed(async (msg, match) => {
      await changeProjectForChat(msg.chat.id, match![1].trim());
    }),
  );

  // --- /run ---
  bot.onText(
    /^\/run\s+(.+)/,
    authed(async (msg, match) => {
      const cmd = match![1];
      const currentProject = getCurrentProject(msg.chat.id);
      bot.sendMessage(msg.chat.id, `Running: ${cmd}`);

      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: currentProject,
          timeout: config.command_timeout_ms,
          shell: '/bin/zsh',
        });

        const output = (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim();
        const formatted = formatOutput(output);
        await sendFormatted(bot, msg.chat.id, formatted);
      } catch (err: any) {
        const output = (err.stdout ?? '') + '\n' + (err.stderr ?? '') + '\n' + err.message;
        const formatted = formatOutput(output.trim());
        await sendFormatted(bot, msg.chat.id, formatted);
      }
    }),
  );

  // --- /help ---
  bot.onText(
    /^\/help/,
    authed(async (msg) => {
      const toolCmds = Object.entries(config.cli_tools)
        .map(([name, tool]) => `/${name} <prompt> — ${tool.description}`)
        .join('\n');

      const text = [
        'Available commands:',
        toolCmds,
        '/claudechat — Start interactive Claude chat',
        '/claudechatyolo — Start Claude chat (skip permissions)',
        '/codexchat — Start interactive Codex chat',
        '/codexchatyolo — Start Codex chat (full auto)',
        '/chatterminal — Open the local Terminal transcript viewer',
        '/endchat — End chat session',
        '/remote — Start Claude remote control session',
        '/endremote — Stop remote control session',
        '/run <cmd> — Run a shell command',
        '/status — System status',
        '/projects — List project directories',
        '/cd <project> — Set working directory for this chat',
        '/sessionstart — Start a computer-use session',
        '/sessionstate — Show the current computer-use session state',
        '/sessionscreenshot — Capture a screenshot from the computer-use host',
        '/sessionartifacts — List stored computer-use artifacts',
        '/sessionlaunch <app> — Launch an app through the computer-use host',
        '/sessionwatchon — Start periodic computer-use screenshots',
        '/sessionwatchoff — Stop periodic computer-use screenshots',
        '/sessionrecordstart — Start computer-use screen recording',
        '/sessionrecordstop — Stop computer-use screen recording',
        '/task <goal> — Run an autonomous Codex task',
        '/taskovernight <goal> — Run an overnight TDD Codex task loop',
        '/taskstatus — Show autonomous task status',
        '/taskstop — Stop the active autonomous task',
        '/telegramsendphotojs — Get Telegram Web photo-send bookmarklet',
        '/restart — Restart the bot',
        '/help — Show this message',
      ].join('\n');

      await sendMenuMessage(msg.chat.id, text);
    }),
  );

  // --- /restart ---
  bot.onText(
    /^\/restart$/,
    authed(async (msg) => {
      await bot.sendMessage(msg.chat.id, 'Restarting...');
      bot.stopPolling();
      process.exit(0);
    }),
  );

  // --- /task ---
  bot.onText(
    /^\/task\s+([\s\S]+)/,
    authed(async (msg, match) => {
      await startTaskFromGoal(msg.chat.id, match![1].trim(), 'standard');
    }),
  );

  // --- /taskovernight ---
  bot.onText(
    /^\/taskovernight\s+([\s\S]+)/,
    authed(async (msg, match) => {
      await startTaskFromGoal(msg.chat.id, match![1].trim(), 'overnight');
    }),
  );

  // --- /taskstatus ---
  bot.onText(
    /^\/taskstatus$/,
    authed(async (msg) => {
      const activeTask = taskRuns.get(msg.chat.id)?.task ?? getChatState(msg.chat.id).task;
      if (!activeTask) {
        await sendMenuMessage(msg.chat.id, 'No task has been started in this chat.');
        return;
      }

      await sendMenuMessage(msg.chat.id, buildAutonomousTaskStatusSummary(activeTask));
    }),
  );

  // --- /taskstop ---
  bot.onText(
    /^\/taskstop$/,
    authed(async (msg) => {
      const activeTask = taskRuns.get(msg.chat.id);
      if (!activeTask) {
        await sendMenuMessage(msg.chat.id, 'No active autonomous task is running.');
        return;
      }

      activeTask.stopRequested = true;
      activeTask.activeHandle?.kill();
      await sendMenuMessage(msg.chat.id, `Stop requested.\n${buildAutonomousTaskStatusSummary(activeTask.task)}`);
    }),
  );

  // --- /telegramsendphotojs ---
  bot.onText(
    /^\/telegramsendphotojs$/,
    authed(async (msg) => {
      const text = [
        'Telegram Web send-photo bookmarklet:',
        buildTelegramWebSendPhotoBookmarklet(),
        '',
        'Use it when the "Send Photo" modal is open.',
        'Paste it into Chrome\'s address bar and press Enter.',
      ].join('\n');

      await bot.sendMessage(msg.chat.id, text);
    }),
  );

  // --- /sessionstart ---
  bot.onText(
    /^\/(?:sessionstart|session\s+start)$/,
    authed(async (msg) => {
      const chatState = getChatState(msg.chat.id);
      try {
        if (!(await isComputerUseHostHealthy())) {
          await bot.sendMessage(msg.chat.id, 'Starting computer-use host...');
          await ensureComputerUseHostAvailable();
        }

        const response = await requestComputerUse<{ ok: true; session: ComputerUseSession }>(
          '/sessions',
          {
            method: 'POST',
            body: JSON.stringify({
              label: `telegram-chat-${msg.chat.id}`,
            }),
          },
        );

        chatState.computerUseSessionId = response.session.id;
        saveState(statePath, state);

        await bot.sendMessage(
          msg.chat.id,
          `Computer-use session started.\nSession: ${response.session.id}`,
        );
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- /sessionscreenshot ---
  bot.onText(
    /^\/(?:sessionscreenshot|session\s+screenshot)$/,
    authed(async (msg) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(
          msg.chat.id,
          'No active computer-use session. Use /sessionstart first.',
        );
        return;
      }

      await bot.sendMessage(msg.chat.id, 'Capturing screenshot...');

      try {
        await sendComputerUseScreenshot(bot, msg.chat.id, sessionId);
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- /sessionstate ---
  bot.onText(
    /^\/(?:sessionstate|session\s+state)$/,
    authed(async (msg) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(
          msg.chat.id,
          'No active computer-use session. Use /sessionstart first.',
        );
        return;
      }

      try {
        await sendComputerUseState(bot, msg.chat.id, sessionId);
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- /sessionartifacts ---
  bot.onText(
    /^\/(?:sessionartifacts|session\s+artifacts)$/,
    authed(async (msg) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(
          msg.chat.id,
          'No active computer-use session. Use /sessionstart first.',
        );
        return;
      }

      try {
        await sendComputerUseArtifacts(bot, msg.chat.id, sessionId);
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- /sessionlaunch ---
  bot.onText(
    /^\/(?:sessionlaunch|session\s+launch)\s+(.+)/,
    authed(async (msg, match) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(
          msg.chat.id,
          'No active computer-use session. Use /sessionstart first.',
        );
        return;
      }

      const appName = match![1].trim();
      if (!appName) {
        await bot.sendMessage(msg.chat.id, 'Usage: /sessionlaunch <app>');
        return;
      }

      try {
        await launchAppInSession(msg.chat.id, appName);
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- /sessionwatchon ---
  bot.onText(
    /^\/(?:sessionwatchon|session\s+watch\s+on)$/,
    authed(async (msg) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(msg.chat.id, 'No active computer-use session. Use /sessionstart first.');
        return;
      }

      startSessionWatch(msg.chat.id, sessionId);
      await bot.sendMessage(
        msg.chat.id,
        `Session watch enabled. Interval: ${Math.round(getComputerUseWatchIntervalMs() / 1000)}s`,
      );
    }),
  );

  // --- /sessionwatchoff ---
  bot.onText(
    /^\/(?:sessionwatchoff|session\s+watch\s+off)$/,
    authed(async (msg) => {
      stopSessionWatch(msg.chat.id);
      await bot.sendMessage(msg.chat.id, 'Session watch disabled.');
    }),
  );

  // --- /sessionrecordstart ---
  bot.onText(
    /^\/(?:sessionrecordstart|session\s+record\s+start)$/,
    authed(async (msg) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(msg.chat.id, 'No active computer-use session. Use /sessionstart first.');
        return;
      }

      try {
        await ensureComputerUseHostAvailable();
        const result = await requestComputerUse<ComputerUseRecordingStartResult>(
          `/sessions/${sessionId}/actions/recording/start`,
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        );
        await bot.sendMessage(
          msg.chat.id,
          buildComputerUseRecordingCaption(result.session_id, result.summary),
        );
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- /sessionrecordstop ---
  bot.onText(
    /^\/(?:sessionrecordstop|session\s+record\s+stop)$/,
    authed(async (msg) => {
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await bot.sendMessage(msg.chat.id, 'No active computer-use session. Use /sessionstart first.');
        return;
      }

      await bot.sendMessage(msg.chat.id, 'Stopping recording...');

      try {
        await ensureComputerUseHostAvailable();
        const result = await requestComputerUse<ComputerUseRecordingStopResult>(
          `/sessions/${sessionId}/actions/recording/stop`,
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        );
        await sendComputerUseRecording(bot, msg.chat.id, result);
      } catch (err: any) {
        await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
      }
    }),
  );

  // --- Remote control state ---
  let remotePty: pty.IPty | null = null;

  // --- /remote ---
  bot.onText(
    /^\/remote$/,
    authed(async (msg) => {
      const currentProject = getCurrentProject(msg.chat.id);
      if (remotePty) {
        bot.sendMessage(msg.chat.id, 'Remote control session already active. Use /endremote to stop it.');
        return;
      }

      const statusMsg = await bot.sendMessage(msg.chat.id, 'Starting remote control session...');

      let claudePath: string;
      try {
        claudePath = (await execAsync('which claude')).stdout.trim();
      } catch {
        // Fallback for launchd environments where PATH is limited
        const fallbackPaths = [
          `${process.env.HOME}/.local/bin/claude`,
          '/usr/local/bin/claude',
        ];
        const fs = await import('fs');
        claudePath = fallbackPaths.find((p) => fs.existsSync(p)) || '';
        if (!claudePath) {
          bot.editMessageText('Could not find claude binary. Check PATH or install Claude CLI.', {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
          }).catch(() => {});
          return;
        }
      }
      console.log(`[remote] Using claude at: ${claudePath}`);
      const proc = pty.spawn(claudePath, [], {
        cwd: currentProject,
        cols: 120,
        rows: 30,
        env: process.env as Record<string, string>,
      });
      remotePty = proc;

      let output = '';
      let urlSent = false;
      let sentRemoteCmd = false;

      const stripAnsi = (s: string) =>
        s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\x1B[^a-zA-Z\[]*[a-zA-Z]/g, '');

      proc.onData((data) => {
        const cleaned = stripAnsi(data);
        output += cleaned;
        const trimmed = cleaned.trim();
        if (trimmed) console.log(`[remote] ${trimmed.slice(0, 200)}`);

        // Wait for the actual prompt character before sending /remote-control
        if (!sentRemoteCmd && output.includes('❯')) {
          sentRemoteCmd = true;
          console.log('[remote] Prompt detected, sending /remote-control');
          setTimeout(() => proc.write('/remote-control\r'), 500);
        }

        // Look for the remote control URL
        const urlMatch = output.match(/(https:\/\/claude\.ai\/\S+)/);
        if (urlMatch && !urlSent) {
          urlSent = true;
          const url = urlMatch[0].replace(/[\x00-\x1F\s]+$/g, '');
          bot.editMessageText(`Remote control session started.\n\n${url}`, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
          }).catch(() => {});
        }
      });

      proc.onExit(({ exitCode }) => {
        console.log(`[remote] process exited with code ${exitCode}`);
        remotePty = null;
        bot.sendMessage(msg.chat.id, 'Remote control session ended.').catch(() => {});
      });

      // Timeout if no URL found
      setTimeout(() => {
        if (!urlSent && remotePty === proc) {
          console.log(`[remote] timeout. Output so far: ${output.slice(-500)}`);
          bot.editMessageText('Failed to get remote control URL (timeout). Check logs.', {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
          }).catch(() => {});
          proc.kill();
          remotePty = null;
        }
      }, 30000);
    }),
  );

  // --- /endremote ---
  bot.onText(
    /^\/endremote$/,
    authed(async (msg) => {
      if (!remotePty) {
        bot.sendMessage(msg.chat.id, 'No active remote control session.');
        return;
      }
      remotePty.kill();
      remotePty = null;
      bot.sendMessage(msg.chat.id, 'Remote control session stopped.');
    }),
  );

  // --- Chat mode state ---
  interface ChatSession {
    provider: ChatProvider;
    command: string;
    args: string[];
    sessionId?: string;
    isFirstMessage: boolean;
    promptPreamble?: string;
    compactSummary?: string;
    recentTurns: CompactChatTurn[];
    busy: boolean;
    activeHandle?: StreamingHandle;
    transcriptPath: string;
  }

  const chatSessions = new Map<number, ChatSession>();

  async function openChatTranscriptForChat(chatId: number): Promise<string> {
    const chatSession = chatSessions.get(chatId);
    const transcriptPath = chatSession?.transcriptPath ?? getChatTranscriptPath(chatId);
    await openChatTranscriptViewer(transcriptPath);
    return transcriptPath;
  }

  async function startChatSession(
    msg: TelegramBot.Message,
    toolKey: string,
    provider: ChatProvider,
    label: string,
  ): Promise<void> {
    if (taskRuns.has(msg.chat.id)) {
      await bot.sendMessage(msg.chat.id, 'An autonomous task is running in this chat. Use /taskstop before starting interactive chat.');
      return;
    }

    const tool = config.cli_tools[toolKey];
    if (!tool) {
      await bot.sendMessage(msg.chat.id, `No "${toolKey}" tool configured.`);
      return;
    }

    const currentProject = getCurrentProject(msg.chat.id);
    const chatState = getChatState(msg.chat.id);
    const existingSession = chatSessions.get(msg.chat.id);
    if (existingSession?.activeHandle) {
      existingSession.activeHandle.kill();
      await existingSession.activeHandle.promise;
    }
    if (existingSession) {
      appendChatTranscript(
        existingSession.transcriptPath,
        `\n============================================================\n${new Date().toISOString()} chat session replaced\n============================================================\n`,
      );
    }

    const transcriptPath = getChatTranscriptPath(msg.chat.id);
    initializeChatTranscript(transcriptPath, provider, currentProject, label);

    let transcriptViewerStatus = `Transcript: ${transcriptPath}`;
    try {
      await openChatTranscriptViewer(transcriptPath);
      transcriptViewerStatus += '\nLocal Terminal viewer opened.';
    } catch (error: any) {
      transcriptViewerStatus += `\nLocal Terminal viewer could not be opened automatically: ${error?.message ?? error}`;
    }

    let promptPreamble: string | undefined;
    let computerUseStatus: string | null = null;

    if (provider === 'codex') {
      const context = await prepareComputerUseCodexContext(
        statePath,
        state,
        chatState,
        msg.chat.id,
      );
      promptPreamble = context.instructions;
      computerUseStatus = context.status;
    }

    chatSessions.set(msg.chat.id, {
      provider,
      command: tool.command,
      args: [...tool.args],
      isFirstMessage: true,
      promptPreamble,
      recentTurns: [],
      busy: false,
      transcriptPath,
    });
    chatState.chatActive = true;
    saveState(statePath, state);

    const lines = [
      `Chat mode started with ${label} in ${basename(currentProject)}. Send messages directly — no /command prefix needed.`,
      '/endchat to exit.',
    ];
    if (provider === 'codex') {
      lines.push('Codex chat context compaction is on.');
    }
    if (computerUseStatus) {
      lines.push(computerUseStatus);
    }
    lines.push(transcriptViewerStatus);

    await bot.sendMessage(msg.chat.id, lines.join('\n'));
  }

  // --- /claudechat ---
  bot.onText(
    /^\/claudechat$/,
    authed(async (msg) => {
      await startChatSession(msg, 'claude', 'claude', 'claude');
    }),
  );

  // --- /claudechatyolo ---
  bot.onText(
    /^\/claudechatyolo$/,
    authed(async (msg) => {
      await startChatSession(msg, 'claudeyolo', 'claude', 'claude (yolo)');
    }),
  );

  // --- /codexchat ---
  bot.onText(
    /^\/codexchat$/,
    authed(async (msg) => {
      await startChatSession(msg, 'codex', 'codex', 'codex');
    }),
  );

  // --- /codexchatyolo ---
  bot.onText(
    /^\/codexchatyolo$/,
    authed(async (msg) => {
      await startChatSession(msg, 'codexyolo', 'codex', 'codex (yolo)');
    }),
  );

  // --- /chatterminal ---
  bot.onText(
    /^\/chatterminal$/,
    authed(async (msg) => {
      try {
        const transcriptPath = await openChatTranscriptForChat(msg.chat.id);
        await bot.sendMessage(msg.chat.id, `Opened local Terminal transcript viewer.\nTranscript: ${transcriptPath}`);
      } catch (error: any) {
        const transcriptPath = chatSessions.get(msg.chat.id)?.transcriptPath ?? getChatTranscriptPath(msg.chat.id);
        await bot.sendMessage(
          msg.chat.id,
          `Could not open the local Terminal transcript viewer automatically.\nTranscript: ${transcriptPath}\nError: ${error?.message ?? error}`,
        );
      }
    }),
  );

  // --- /endchat ---
  bot.onText(
    /^\/endchat$/,
    authed(async (msg) => {
      const chatSession = chatSessions.get(msg.chat.id);
      if (!chatSession) {
        bot.sendMessage(msg.chat.id, 'No active chat session.');
        return;
      }
      const activeHandle = chatSession.activeHandle;
      chatSessions.delete(msg.chat.id);
      getChatState(msg.chat.id).chatActive = false;
      saveState(statePath, state);
      if (activeHandle) {
        activeHandle.kill();
        await activeHandle.promise;
      }
      appendChatTranscript(
        chatSession.transcriptPath,
        `\n============================================================\n${new Date().toISOString()} chat session ended\n============================================================\n`,
      );
      bot.sendMessage(msg.chat.id, 'Chat session ended.');
    }),
  );

  // --- Dynamic CLI tool commands ---
  for (const [name, tool] of Object.entries(config.cli_tools)) {
    const regex = new RegExp(`^\\/${name}\\s+([\\s\\S]+)`);

    bot.onText(
      regex,
      authed(async (msg, match) => {
        const prompt = match![1].trim();
        const currentProject = getCurrentProject(msg.chat.id);
        bot.sendMessage(msg.chat.id, `Running ${name}...`);

        try {
          let promptForTool = prompt;
          let computerUseStatus: string | undefined;

          if (tool.command === 'codex') {
            const context = await prepareComputerUseCodexContext(
              statePath,
              state,
              getChatState(msg.chat.id),
              msg.chat.id,
            );
            computerUseStatus = context.status;
            if (context.sessionId) {
              promptForTool = buildComputerUseCodexPrompt(context.sessionId, prompt);
            }
          }

          if (computerUseStatus) {
            await bot.sendMessage(msg.chat.id, computerUseStatus);
          }

          const args = tool.command === 'codex'
            ? buildCodexExecArgs(tool.args, promptForTool)
            : [...tool.args, promptForTool];
          const output = await runCliTool(
            tool.command,
            args,
            currentProject,
            config.command_timeout_ms,
          );
          const parsed = parseCliOutput(output);
          await sendCliResult(bot, msg.chat.id, parsed);
        } catch (err: any) {
          const formatted = formatOutput(`Error: ${err.message}`);
          await sendFormatted(bot, msg.chat.id, formatted);
        }
      }),
    );
  }

  // --- Guided keyboard and pending input handling ---
  bot.on('message', async (msg) => {
    if (!msg.from || !isAllowedUser(msg.from.id, allowedUsers)) return;
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text.trim();
    const pendingAction = pendingGuidedActions.get(msg.chat.id);
    const markHandled = () => {
      (msg as TelegramBot.Message & { __guidedHandled?: boolean }).__guidedHandled = true;
    };

    if (pendingAction) {
      clearPendingGuidedAction(msg.chat.id);
      markHandled();

      try {
        if (pendingAction === 'task_goal') {
          await startTaskFromGoal(msg.chat.id, text);
          return;
        }

        if (pendingAction === 'launch_app') {
          await launchAppInSession(msg.chat.id, text);
          return;
        }

        if (pendingAction === 'change_project') {
          await changeProjectForChat(msg.chat.id, text);
          return;
        }
      } catch (error: any) {
        await sendMenuMessage(msg.chat.id, `Error: ${error.message}`);
        return;
      }
    }

    if (text === 'Task') {
      markHandled();
      if (taskRuns.has(msg.chat.id)) {
        await sendMenuMessage(msg.chat.id, 'A task is already running. Use Task Status or Task Stop.');
        return;
      }
      setPendingGuidedAction(msg.chat.id, 'task_goal');
      await sendMenuMessage(msg.chat.id, 'Send the task goal as a normal message.');
      return;
    }

    if (text === 'Launch App') {
      markHandled();
      setPendingGuidedAction(msg.chat.id, 'launch_app');
      await sendMenuMessage(msg.chat.id, 'Send the app name to launch, for example: Firefox');
      return;
    }

    if (text === 'Change Project') {
      markHandled();
      setPendingGuidedAction(msg.chat.id, 'change_project');
      await sendProjectsMessage(msg.chat.id);
      await sendMenuMessage(msg.chat.id, 'Send the project number or basename.');
      return;
    }

    if (text === 'Status') {
      markHandled();
      try {
        await sendStatusMessage(msg.chat.id);
      } catch (error: any) {
        await sendMenuMessage(msg.chat.id, `Error: ${error.message}`);
      }
      return;
    }

    if (text === 'Projects') {
      markHandled();
      await sendProjectsMessage(msg.chat.id);
      return;
    }

    if (text === 'Screenshot') {
      markHandled();
      const sessionId = getChatState(msg.chat.id).computerUseSessionId;
      if (!sessionId) {
        await sendMenuMessage(msg.chat.id, 'No active computer-use session. Use /sessionstart first.');
        return;
      }
      try {
        await sendComputerUseScreenshot(bot, msg.chat.id, sessionId);
      } catch (error: any) {
        await sendMenuMessage(msg.chat.id, `Error: ${error.message}`);
      }
      return;
    }

    if (text === 'Task Status') {
      markHandled();
      const activeTask = taskRuns.get(msg.chat.id)?.task ?? getChatState(msg.chat.id).task;
      await sendMenuMessage(
        msg.chat.id,
        activeTask ? buildAutonomousTaskStatusSummary(activeTask) : 'No task has been started in this chat.',
      );
      return;
    }

    if (text === 'Task Stop') {
      markHandled();
      const activeTask = taskRuns.get(msg.chat.id);
      if (!activeTask) {
        await sendMenuMessage(msg.chat.id, 'No active autonomous task is running.');
        return;
      }
      activeTask.stopRequested = true;
      activeTask.activeHandle?.kill();
      await sendMenuMessage(msg.chat.id, `Stop requested.\n${buildAutonomousTaskStatusSummary(activeTask.task)}`);
      return;
    }

    if (text === 'Codex Chat') {
      markHandled();
      await startChatSession(msg, 'codex', 'codex', 'codex');
      return;
    }

    if (text === 'Chat Terminal') {
      markHandled();
      try {
        const transcriptPath = await openChatTranscriptForChat(msg.chat.id);
        await sendMenuMessage(msg.chat.id, `Opened local Terminal transcript viewer.\nTranscript: ${transcriptPath}`);
      } catch (error: any) {
        const transcriptPath = chatSessions.get(msg.chat.id)?.transcriptPath ?? getChatTranscriptPath(msg.chat.id);
        await sendMenuMessage(
          msg.chat.id,
          `Could not open the local Terminal transcript viewer automatically.\nTranscript: ${transcriptPath}\nError: ${error?.message ?? error}`,
        );
      }
      return;
    }

    if (text === 'End Chat') {
      markHandled();
      const chatSession = chatSessions.get(msg.chat.id);
      if (!chatSession) {
        await sendMenuMessage(msg.chat.id, 'No active chat session.');
        return;
      }
      const activeHandle = chatSession.activeHandle;
      chatSessions.delete(msg.chat.id);
      getChatState(msg.chat.id).chatActive = false;
      saveState(statePath, state);
      if (activeHandle) {
        activeHandle.kill();
        await activeHandle.promise;
      }
      appendChatTranscript(
        chatSession.transcriptPath,
        `\n============================================================\n${new Date().toISOString()} chat session ended\n============================================================\n`,
      );
      await sendMenuMessage(msg.chat.id, 'Chat session ended.');
      return;
    }

    if (text === 'Help') {
      markHandled();
      const toolCmds = Object.entries(config.cli_tools)
        .map(([name, tool]) => `/${name} <prompt> — ${tool.description}`)
        .join('\n');

      const helpText = [
        'Available commands:',
        toolCmds,
        '/claudechat — Start interactive Claude chat',
        '/claudechatyolo — Start Claude chat (skip permissions)',
        '/codexchat — Start interactive Codex chat',
        '/codexchatyolo — Start Codex chat (full auto)',
        '/chatterminal — Open the local Terminal transcript viewer',
        '/task <goal> — Run an autonomous Codex task',
        '/taskovernight <goal> — Run an overnight TDD Codex task loop',
        '/taskstatus — Show autonomous task status',
        '/taskstop — Stop the active autonomous task',
      ].join('\n');
      await sendMenuMessage(msg.chat.id, helpText);
    }
  });

  // --- Chat mode: run a single turn with streaming output ---
  async function runChatTurn(chatId: number, prompt: string): Promise<void> {
    const chatSession = chatSessions.get(chatId);
    if (!chatSession) return;

    const sessionAtStart = chatSession;
    const currentProject = getCurrentProject(chatId);
    sessionAtStart.busy = true;
    const promptForTool = sessionAtStart.provider === 'codex'
      ? buildCompactedChatTurnPrompt(
        prompt,
        sessionAtStart.promptPreamble,
        sessionAtStart.compactSummary,
        sessionAtStart.recentTurns,
      )
      : prompt;

    const args = sessionAtStart.provider === 'codex'
      ? buildCompactedCodexChatArgs(
        sessionAtStart.args,
        promptForTool,
      )
      : [
        ...sessionAtStart.args,
        ...(sessionAtStart.isFirstMessage ? [] : ['--continue']),
        promptForTool,
      ];

    appendChatTranscript(
      sessionAtStart.transcriptPath,
      [
        '',
        '------------------------------------------------------------',
        `${new Date().toISOString()} user`,
        prompt,
        '',
        `${new Date().toISOString()} command`,
        [sessionAtStart.command, ...args].map(shellQuote).join(' '),
        '',
      ].join('\n'),
    );

    // Send initial "Thinking..." message that we'll edit with streaming content
    const statusMsg = await bot.sendMessage(chatId, 'Thinking...');
    const msgId = statusMsg.message_id;

    const handle = spawnStreamingCli(
      sessionAtStart.command,
      args,
      currentProject,
      config.command_timeout_ms,
      sessionAtStart.provider,
      sessionAtStart.transcriptPath,
    );
    sessionAtStart.activeHandle = handle;

    // Accumulate streamed content and update Telegram message periodically
    let streamedThinking = '';
    let streamedText = '';
    let lastDisplay = '';
    let phase: 'thinking' | 'responding' = 'thinking';

    handle.events.on('thinking', (delta: string) => {
      streamedThinking += delta;
    });

    handle.events.on('text', (delta: string) => {
      if (phase === 'thinking') phase = 'responding';
      streamedText = sessionAtStart.provider === 'codex'
        ? delta
        : streamedText + delta;
    });

    handle.events.on('sessionId', (sessionId: string) => {
      const activeSession = chatSessions.get(chatId);
      if (activeSession === sessionAtStart) {
        activeSession.sessionId = sessionId;
      }
    });

    // Periodically edit the Telegram message with accumulated content
    const updateInterval = setInterval(async () => {
      let display: string;
      if (phase === 'responding' && streamedText) {
        display = truncateForTelegram(streamedText);
      } else if (streamedThinking) {
        display = truncateForTelegram('Thinking...\n\n' + streamedThinking);
      } else {
        return; // nothing to show yet
      }
      if (display === lastDisplay) return;
      lastDisplay = display;
      try {
        await bot.editMessageText(display, { chat_id: chatId, message_id: msgId });
      } catch {}
    }, STREAM_UPDATE_INTERVAL_MS);

    try {
      const outcome = await handle.promise;
      clearInterval(updateInterval);

      if (chatSessions.get(chatId) !== sessionAtStart) return;

      if (outcome.killed) {
        appendChatTranscript(sessionAtStart.transcriptPath, '\n[interrupted by new message]\n');
        // Process was killed by a steer — update the message to indicate interruption
        const partial = streamedText
          ? truncateForTelegram(streamedText + '\n\n[interrupted]')
          : '[interrupted by new message]';
        try {
          await bot.editMessageText(partial, { chat_id: chatId, message_id: msgId });
        } catch {}
        sessionAtStart.isFirstMessage = false;
        return;
      }

      sessionAtStart.isFirstMessage = false;
      sessionAtStart.activeHandle = undefined;

      if (outcome.error) {
        appendChatTranscript(sessionAtStart.transcriptPath, `\n[error]\n${outcome.error}\n`);
        try {
          await bot.editMessageText(
            truncateForTelegram(`Error: ${outcome.error}`),
            { chat_id: chatId, message_id: msgId },
          );
        } catch {}
        return;
      }

      if (outcome.result) {
        appendChatTranscript(
          sessionAtStart.transcriptPath,
          `\n[result]\n${outcome.result.text}${outcome.result.stats ? `\n\n[stats] ${outcome.result.stats}` : ''}\n`,
        );
        if (sessionAtStart.provider === 'codex') {
          const nextHistory = updateCompactChatHistory(
            sessionAtStart.compactSummary,
            sessionAtStart.recentTurns,
            prompt,
            outcome.result.text,
          );
          sessionAtStart.compactSummary = nextHistory.compactSummary;
          sessionAtStart.recentTurns = nextHistory.recentTurns;
        }
        // Delete the streaming message — we'll send the final result properly formatted
        try { await bot.deleteMessage(chatId, msgId); } catch {}
        await sendCliResult(bot, chatId, outcome.result);
      }
    } catch (err: any) {
      appendChatTranscript(sessionAtStart.transcriptPath, `\n[exception]\n${err.message}\n`);
      clearInterval(updateInterval);
      try {
        await bot.editMessageText(
          truncateForTelegram(`Error: ${err.message}`),
          { chat_id: chatId, message_id: msgId },
        );
      } catch {}
    } finally {
      if (chatSessions.get(chatId) === sessionAtStart) {
        sessionAtStart.busy = false;
        sessionAtStart.activeHandle = undefined;
      }
    }
  }

  // --- Chat mode catch-all ---
  bot.on('message', async (msg) => {
    if (!msg.from || !isAllowedUser(msg.from.id, allowedUsers)) return;
    if (!msg.text || msg.text.startsWith('/')) return;
    if ((msg as TelegramBot.Message & { __guidedHandled?: boolean }).__guidedHandled) return;
    const chatSession = chatSessions.get(msg.chat.id);
    if (!chatSession) return;

    if (chatSession.busy) {
      // Kill the running process and steer with the new message
      const handle = chatSession.activeHandle;
      if (handle) {
        bot.sendMessage(msg.chat.id, `Steering: "${msg.text}"`);
        handle.kill();
        // Wait for the killed process to clean up
        await handle.promise;
      }
      if (chatSessions.get(msg.chat.id) === chatSession) {
        chatSession.busy = false;
        chatSession.activeHandle = undefined;
      }
    }

    // Run the new turn (either first message or steer via --continue)
    await runChatTurn(msg.chat.id, msg.text);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    bot.stopPolling();
    process.exit(0);
  });
}

// Only run when executed directly, not when imported by tests
const isDirectRun = process.argv[1]?.endsWith('bot.ts');
if (isDirectRun) {
  main();
}
