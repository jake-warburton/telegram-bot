import TelegramBot from 'node-telegram-bot-api';
import { exec, spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { loadState, saveState } from './state.js';
import type { BotState } from './state.js';

const execAsync = promisify(exec);

// --- Config ---

interface CliTool {
  command: string;
  args: string[];
  promptArg: 'append';
  description: string;
}

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

// --- Command runner ---

function runCliTool(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullCommand = [command, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const proc = spawn('/bin/zsh', ['-li', '-c', fullCommand], {
      cwd,
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
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
      const output = (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim();
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output || `Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Streaming CLI runner for chat mode ---

interface StreamingHandle {
  proc: ChildProcess;
  events: EventEmitter;  // emits 'text', 'thinking', 'result', 'error', 'done'
  kill: () => void;
  promise: Promise<{ killed: boolean; result?: CliResult; error?: string }>;
}

function spawnStreamingCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): StreamingHandle {
  const fullCommand = [command, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const proc = spawn('/bin/zsh', ['-li', '-c', fullCommand], { cwd });
  const events = new EventEmitter();
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
    let accText = '';
    let accThinking = '';
    let resultJson: any = null;
    let lineBuffer = '';

    const processLine = (line: string) => {
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
    };

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) processLine(line.trim());
      }
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString();
      if (!line.includes('no stdin data received')) {
        stderr += line;
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Process any remaining buffered line
      if (lineBuffer.trim()) processLine(lineBuffer.trim());

      if (killed) {
        resolve({ killed: true });
        return;
      }

      if (resultJson) {
        const parts: string[] = [];
        if (resultJson.usage) {
          const input = (resultJson.usage.input_tokens ?? 0) + (resultJson.usage.cache_read_input_tokens ?? 0) + (resultJson.usage.cache_creation_input_tokens ?? 0);
          const output = resultJson.usage.output_tokens ?? 0;
          parts.push(`${input.toLocaleString()} in / ${output.toLocaleString()} out`);
        }
        if (resultJson.duration_ms != null) {
          parts.push(`${(resultJson.duration_ms / 1000).toFixed(1)}s`);
        }
        resolve({
          killed: false,
          result: {
            text: resultJson.result,
            stats: parts.length > 0 ? parts.join(' | ') : undefined,
            thinking: accThinking || undefined,
          },
        });
      } else if (code === 0) {
        resolve({ killed: false, result: { text: accText || stdout.trim() } });
      } else {
        const output = (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim();
        resolve({ killed: false, error: output || `Process exited with code ${code}` });
      }
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

function parseCliOutput(raw: string): CliResult {
  const lines = raw.split('\n').filter(l => l.trim());

  let resultJson: any = null;
  let thinking = '';

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
    } catch {}
  }

  if (resultJson) {
    const parts: string[] = [];
    if (resultJson.usage) {
      const input = (resultJson.usage.input_tokens ?? 0) + (resultJson.usage.cache_read_input_tokens ?? 0) + (resultJson.usage.cache_creation_input_tokens ?? 0);
      const output = resultJson.usage.output_tokens ?? 0;
      parts.push(`${input.toLocaleString()} in / ${output.toLocaleString()} out`);
    }
    if (resultJson.duration_ms != null) {
      parts.push(`${(resultJson.duration_ms / 1000).toFixed(1)}s`);
    }
    return {
      text: resultJson.result,
      stats: parts.length > 0 ? parts.join(' | ') : undefined,
      thinking: thinking || undefined,
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
    await bot.sendDocument(chatId, filePath, { caption });
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
      await bot.sendDocument(chatId, filePath, { caption: 'Thinking' });
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
  let currentProject = state.currentProject || config.default_project;

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

  // Register commands with Telegram's autocomplete menu
  const botCommands: TelegramBot.BotCommand[] = [
    ...Object.entries(config.cli_tools).map(([name, tool]) => ({
      command: name,
      description: tool.description,
    })),
    { command: 'chat', description: 'Start interactive Claude chat' },
    { command: 'chatyolo', description: 'Start Claude chat (skip permissions)' },
    { command: 'endchat', description: 'End chat session' },
    { command: 'run', description: 'Run a shell command' },
    { command: 'status', description: 'System status' },
    { command: 'projects', description: 'List project directories' },
    { command: 'cd', description: 'Set working directory' },
    { command: 'help', description: 'List commands' },
    { command: 'restart', description: 'Restart the bot' },
  ];
  await bot.setMyCommands(botCommands);

  console.log(`Bot started. Allowed users: ${JSON.stringify(allowedUsers)}`);
  console.log('Listening for messages...');

  // Notify allowed users that the bot has started
  const now = Date.now();
  const STARTUP_COOLDOWN_MS = 30_000;
  const suppressStartupMsg = (now - state.lastStartTime) < STARTUP_COOLDOWN_MS;
  state.lastStartTime = now;
  saveState(statePath, state);

  if (!suppressStartupMsg) {
    for (const userId of allowedUsers) {
      bot.sendMessage(userId, `Bot started. CWD: ${basename(currentProject)}`).catch((err: any) => {
        console.error(`Failed to send startup message to ${userId}: ${err.message}`);
      });
    }
    if (state.chatActive) {
      for (const userId of allowedUsers) {
        bot.sendMessage(userId, 'Previous chat session was interrupted by restart.').catch(() => {});
      }
    }
  } else {
    console.log('Startup message suppressed (cooldown)');
  }

  if (state.chatActive) {
    state.chatActive = false;
    saveState(statePath, state);
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

  // --- /status ---
  bot.onText(
    /^\/status/,
    authed(async (msg) => {
      try {
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

        bot.sendMessage(msg.chat.id, text);
      } catch (err) {
        bot.sendMessage(msg.chat.id, `Error: ${err}`);
      }
    }),
  );

  // --- /projects ---
  bot.onText(
    /^\/projects/,
    authed((msg) => {
      const list = config.projects
        .map((p, i) => {
          const marker = p === currentProject ? ' ← current' : '';
          return `${i + 1}. ${basename(p)}${marker}`;
        })
        .join('\n');

      bot.sendMessage(msg.chat.id, list || 'No projects configured.');
    }),
  );

  // --- /cd ---
  bot.onText(
    /^\/cd\s+(.+)/,
    authed((msg, match) => {
      const arg = match![1].trim();
      const project = parseProjectArg(arg, config.projects);
      if (!project) {
        bot.sendMessage(
          msg.chat.id,
          `Project not found: "${arg}". Use /projects to see available options.`,
        );
        return;
      }
      currentProject = project;
      state.currentProject = currentProject;
      saveState(statePath, state);
      bot.sendMessage(msg.chat.id, `Working directory: ${currentProject}`);
    }),
  );

  // --- /run ---
  bot.onText(
    /^\/run\s+(.+)/,
    authed(async (msg, match) => {
      const cmd = match![1];
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
    authed((msg) => {
      const toolCmds = Object.entries(config.cli_tools)
        .map(([name, tool]) => `/${name} <prompt> — ${tool.description}`)
        .join('\n');

      const text = [
        'Available commands:',
        toolCmds,
        '/chat — Start interactive Claude chat',
        '/chatyolo — Start Claude chat (skip permissions)',
        '/endchat — End chat session',
        '/run <cmd> — Run a shell command',
        '/status — System status',
        '/projects — List project directories',
        '/cd <project> — Set working directory',
        '/restart — Restart the bot',
        '/help — Show this message',
      ].join('\n');

      bot.sendMessage(msg.chat.id, text);
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

  // --- Chat mode state ---
  interface ChatSession {
    command: string;
    args: string[];  // base args (e.g. ["--print", "--dangerously-skip-permissions"])
    isFirstMessage: boolean;
    busy: boolean;
    activeHandle?: StreamingHandle;  // current running process
  }

  let chatSession: ChatSession | null = null;

  // --- /chat ---
  bot.onText(
    /^\/chat$/,
    authed((msg) => {
      const tool = config.cli_tools['claude'];
      if (!tool) {
        bot.sendMessage(msg.chat.id, 'No "claude" tool configured.');
        return;
      }
      chatSession = {
        command: tool.command,
        args: [...tool.args],
        isFirstMessage: true,
        busy: false,
      };
      state.chatActive = true;
      saveState(statePath, state);
      bot.sendMessage(msg.chat.id, `Chat mode started with claude in ${basename(currentProject)}. Send messages directly — no /command prefix needed.\n/endchat to exit.`);
    }),
  );

  // --- /chatyolo ---
  bot.onText(
    /^\/chatyolo$/,
    authed((msg) => {
      const tool = config.cli_tools['claudeyolo'];
      if (!tool) {
        bot.sendMessage(msg.chat.id, 'No "claudeyolo" tool configured.');
        return;
      }
      chatSession = {
        command: tool.command,
        args: [...tool.args],
        isFirstMessage: true,
        busy: false,
      };
      state.chatActive = true;
      saveState(statePath, state);
      bot.sendMessage(msg.chat.id, `Chat mode started with claude (yolo) in ${basename(currentProject)}. Send messages directly — no /command prefix needed.\n/endchat to exit.`);
    }),
  );

  // --- /endchat ---
  bot.onText(
    /^\/endchat$/,
    authed((msg) => {
      if (!chatSession) {
        bot.sendMessage(msg.chat.id, 'No active chat session.');
        return;
      }
      chatSession = null;
      state.chatActive = false;
      saveState(statePath, state);
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
        bot.sendMessage(msg.chat.id, `Running ${name}...`);

        try {
          const args = [...tool.args, prompt];
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

  // --- Chat mode: run a single turn with streaming output ---
  async function runChatTurn(chatId: number, prompt: string): Promise<void> {
    if (!chatSession) return;

    chatSession.busy = true;

    const args = [...chatSession.args];
    if (!chatSession.isFirstMessage) {
      args.push('--continue');
    }
    args.push(prompt);

    // Send initial "Thinking..." message that we'll edit with streaming content
    const statusMsg = await bot.sendMessage(chatId, 'Thinking...');
    const msgId = statusMsg.message_id;

    const handle = spawnStreamingCli(
      chatSession.command,
      args,
      currentProject,
      config.command_timeout_ms,
    );
    chatSession.activeHandle = handle;

    // Accumulate streamed text and update Telegram message periodically
    let streamedText = '';
    let lastUpdateText = '';
    let phase: 'thinking' | 'responding' = 'thinking';

    handle.events.on('thinking', (delta: string) => {
      // We don't stream thinking to the live message — too noisy
      // It'll be sent separately at the end if present
    });

    handle.events.on('text', (delta: string) => {
      if (phase === 'thinking') phase = 'responding';
      streamedText += delta;
    });

    // Periodically edit the Telegram message with accumulated text
    const updateInterval = setInterval(async () => {
      if (streamedText && streamedText !== lastUpdateText) {
        const display = phase === 'thinking'
          ? 'Thinking...'
          : truncateForTelegram(streamedText);
        lastUpdateText = streamedText;
        try {
          await bot.editMessageText(display, { chat_id: chatId, message_id: msgId });
        } catch {}
      }
    }, STREAM_UPDATE_INTERVAL_MS);

    try {
      const outcome = await handle.promise;
      clearInterval(updateInterval);

      if (!chatSession) return; // session ended while running

      if (outcome.killed) {
        // Process was killed by a steer — update the message to indicate interruption
        const partial = streamedText
          ? truncateForTelegram(streamedText + '\n\n[interrupted]')
          : '[interrupted by new message]';
        try {
          await bot.editMessageText(partial, { chat_id: chatId, message_id: msgId });
        } catch {}
        chatSession.isFirstMessage = false;
        return;
      }

      chatSession.isFirstMessage = false;
      chatSession.activeHandle = undefined;

      if (outcome.error) {
        try {
          await bot.editMessageText(
            truncateForTelegram(`Error: ${outcome.error}`),
            { chat_id: chatId, message_id: msgId },
          );
        } catch {}
        return;
      }

      if (outcome.result) {
        // Delete the streaming message — we'll send the final result properly formatted
        try { await bot.deleteMessage(chatId, msgId); } catch {}
        await sendCliResult(bot, chatId, outcome.result);
      }
    } catch (err: any) {
      clearInterval(updateInterval);
      try {
        await bot.editMessageText(
          truncateForTelegram(`Error: ${err.message}`),
          { chat_id: chatId, message_id: msgId },
        );
      } catch {}
    } finally {
      if (chatSession) {
        chatSession.busy = false;
        chatSession.activeHandle = undefined;
      }
    }
  }

  // --- Chat mode catch-all ---
  bot.on('message', async (msg) => {
    if (!msg.from || !isAllowedUser(msg.from.id, allowedUsers)) return;
    if (!msg.text || msg.text.startsWith('/')) return;
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
      if (chatSession) {
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
