import TelegramBot from 'node-telegram-bot-api';
import { exec, spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

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
    const proc = spawn(command, args, {
      cwd,
      shell: '/bin/zsh',
      env: { ...process.env, PATH: process.env.PATH },
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => (stderr += data));

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

// --- Output sender ---

async function sendFormatted(
  bot: TelegramBot,
  chatId: number,
  output: FormattedOutput,
): Promise<void> {
  if (output.type === 'text') {
    await bot.sendMessage(chatId, output.content);
  } else {
    const filePath = join(tmpdir(), `output-${Date.now()}.txt`);
    writeFileSync(filePath, output.content);
    await bot.sendDocument(chatId, filePath, {
      caption: 'Output exceeded 4096 chars — sent as file.',
    });
  }
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
  let currentProject = config.default_project;

  const bot = new TelegramBot(token, { polling: true });

  // Register commands with Telegram's autocomplete menu
  const botCommands: TelegramBot.BotCommand[] = [
    ...Object.entries(config.cli_tools).map(([name, tool]) => ({
      command: name,
      description: tool.description,
    })),
    { command: 'run', description: 'Run a shell command' },
    { command: 'status', description: 'System status' },
    { command: 'projects', description: 'List project directories' },
    { command: 'cd', description: 'Set working directory' },
    { command: 'help', description: 'List commands' },
  ];
  await bot.setMyCommands(botCommands);

  console.log('Bot started. Listening for messages...');

  // Auth guard — wraps every handler
  function authed(
    handler: (msg: TelegramBot.Message, match: RegExpExecArray | null) => void,
  ) {
    return (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
      if (!msg.from || !isAllowedUser(msg.from.id, allowedUsers)) return;
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
        '/run <cmd> — Run a shell command',
        '/status — System status',
        '/projects — List project directories',
        '/cd <project> — Set working directory',
        '/help — Show this message',
      ].join('\n');

      bot.sendMessage(msg.chat.id, text);
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
          const formatted = formatOutput(output);
          await sendFormatted(bot, msg.chat.id, formatted);
        } catch (err: any) {
          const formatted = formatOutput(`Error: ${err.message}`);
          await sendFormatted(bot, msg.chat.id, formatted);
        }
      }),
    );
  }

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
