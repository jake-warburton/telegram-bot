import { describe, it, expect } from 'vitest';
import {
  buildMainReplyKeyboard,
  buildAutonomousTaskPrompt,
  buildAutonomousTaskStatusSummary,
  buildChatTranscriptTailCommand,
  buildCodexExecArgs,
  buildCodexChatArgs,
  buildCodexMcpAddArgs,
  buildComputerUseCodexInstructions,
  buildComputerUseCodexPrompt,
  buildComputerUseArtifactsSummary,
  buildComputerUseScreenshotCaption,
  buildComputerUseStateSummary,
  buildTelegramConnectivitySummary,
  buildTelegramWebSendPhotoBookmarklet,
  isAllowedUser,
  formatOutput,
  getChatTranscriptPath,
  isExpectedComputerUseMcpServer,
  parseProjectArg,
  parseCliOutput,
} from './bot.js';
import type { TaskState } from './state.js';

describe('isAllowedUser', () => {
  it('allows whitelisted user IDs', () => {
    expect(isAllowedUser(123, [123, 456])).toBe(true);
  });

  it('rejects non-whitelisted user IDs', () => {
    expect(isAllowedUser(789, [123, 456])).toBe(false);
  });

  it('rejects when allowlist is empty', () => {
    expect(isAllowedUser(123, [])).toBe(false);
  });
});

describe('formatOutput', () => {
  it('wraps short output in code block', () => {
    const result = formatOutput('hello world');
    expect(result).toEqual({ type: 'text', content: '```\nhello world\n```' });
  });

  it('returns file type for output over 4096 chars', () => {
    const longOutput = 'x'.repeat(5000);
    const result = formatOutput(longOutput);
    expect(result).toEqual({ type: 'file', content: longOutput });
  });

  it('accounts for code fence chars in length check', () => {
    const exactFit = 'x'.repeat(4088);
    const result = formatOutput(exactFit);
    expect(result).toEqual({ type: 'text', content: '```\n' + exactFit + '\n```' });
  });

  it('sends as file when code fence pushes over limit', () => {
    const justOver = 'x'.repeat(4089);
    const result = formatOutput(justOver);
    expect(result).toEqual({ type: 'file', content: justOver });
  });

  it('handles empty output', () => {
    const result = formatOutput('');
    expect(result).toEqual({ type: 'text', content: '(no output)' });
  });
});

describe('parseProjectArg', () => {
  const projects = [
    '/Users/jake/repos/project-a',
    '/Users/jake/repos/project-b',
    '/Users/jake/repos/my-app',
  ];

  it('matches by index (1-based)', () => {
    expect(parseProjectArg('1', projects)).toBe('/Users/jake/repos/project-a');
  });

  it('matches by basename', () => {
    expect(parseProjectArg('my-app', projects)).toBe('/Users/jake/repos/my-app');
  });

  it('matches by partial basename', () => {
    expect(parseProjectArg('project-a', projects)).toBe('/Users/jake/repos/project-a');
  });

  it('returns null for no match', () => {
    expect(parseProjectArg('nonexistent', projects)).toBeNull();
  });

  it('returns null for out-of-range index', () => {
    expect(parseProjectArg('99', projects)).toBeNull();
  });
});

describe('buildCodexExecArgs', () => {
  it('runs codex through exec with the git repo check disabled', () => {
    expect(buildCodexExecArgs(['--quiet'], 'hello')).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--json',
      'hello',
    ]);
  });

  it('preserves supported codex flags', () => {
    expect(buildCodexExecArgs(['--quiet', '--full-auto'], 'hello')).toEqual([
      'exec',
      '--full-auto',
      '--skip-git-repo-check',
      '--json',
      'hello',
    ]);
  });
});

describe('buildCodexChatArgs', () => {
  it('starts a new exec session and strips --quiet', () => {
    expect(buildCodexChatArgs(['--quiet'], 'hello')).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--json',
      'hello',
    ]);
  });

  it('resumes an existing session and preserves supported flags', () => {
    expect(buildCodexChatArgs(['--quiet', '--full-auto'], 'continue', 'thread-123')).toEqual([
      'exec',
      'resume',
      '--full-auto',
      '--skip-git-repo-check',
      '--json',
      'thread-123',
      'continue',
    ]);
  });
});

describe('parseCliOutput', () => {
  it('parses codex json output into message text and usage stats', () => {
    const output = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'First reply',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Second reply',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1200,
          output_tokens: 34,
        },
      }),
    ].join('\n');

    expect(parseCliOutput(output)).toEqual({
      text: 'First reply\n\nSecond reply',
      stats: '1,200 in / 34 out',
    });
  });
});

describe('buildComputerUseScreenshotCaption', () => {
  it('includes session id and summary', () => {
    expect(buildComputerUseScreenshotCaption('session-123', 'Captured screenshot.', null)).toBe(
      'Session: session-123\nCaptured screenshot.',
    );
  });

  it('includes frontmost app when present', () => {
    expect(
      buildComputerUseScreenshotCaption('session-123', 'Captured screenshot of Firefox.', 'Firefox'),
    ).toBe(
      'Session: session-123\nCaptured screenshot of Firefox.\nFrontmost app: Firefox',
    );
  });
});

describe('buildComputerUseStateSummary', () => {
  it('includes frontmost app, recording state, and artifact count', () => {
    expect(
      buildComputerUseStateSummary('session-123', 'Fetched state.', {
        frontmost_app: 'Finder',
        recording: false,
        artifacts_count: 3,
      }),
    ).toBe(
      'Session: session-123\nFetched state.\nFrontmost app: Finder\nRecording: off\nArtifacts: 3',
    );
  });
});

describe('buildComputerUseArtifactsSummary', () => {
  it('lists recent artifact filenames', () => {
    expect(
      buildComputerUseArtifactsSummary('session-123', 'Found 2 artifacts.', [
        {
          id: 'a1',
          type: 'screenshot',
          path: '/tmp/first.png',
          mime_type: 'image/png',
          created_at: '2026-03-30T00:00:00.000Z',
          size_bytes: 1,
        },
        {
          id: 'a2',
          type: 'recording',
          path: '/tmp/clip.mov',
          mime_type: 'video/quicktime',
          created_at: '2026-03-30T00:00:01.000Z',
          size_bytes: 2,
        },
      ]),
    ).toBe(
      'Session: session-123\nFound 2 artifacts.\n- screenshot: first.png\n- recording: clip.mov',
    );
  });

  it('handles empty artifact lists', () => {
    expect(
      buildComputerUseArtifactsSummary('session-123', 'Found 0 artifacts.', []),
    ).toBe(
      'Session: session-123\nFound 0 artifacts.\nNo artifacts yet.',
    );
  });
});

describe('buildComputerUseCodexInstructions', () => {
  it('includes the active session id and screenshot guidance', () => {
    expect(buildComputerUseCodexInstructions('session-123')).toContain(
      'Reuse the active computer-use session id `session-123`',
    );
    expect(buildComputerUseCodexInstructions('session-123')).toContain(
      'Capture a screenshot before acting when the current screen state is unclear.',
    );
  });
});

describe('buildComputerUseCodexPrompt', () => {
  it('wraps the user prompt after the computer-use guidance', () => {
    expect(buildComputerUseCodexPrompt('session-123', 'Open Firefox')).toContain(
      'User request:\nOpen Firefox',
    );
  });
});

describe('buildAutonomousTaskPrompt', () => {
  it('includes goal, attempt, and project', () => {
    const prompt = buildAutonomousTaskPrompt(
      'Ship a pricing page',
      '/Users/jake/repos/my-app',
      2,
      5,
    );

    expect(prompt).toContain('Goal: Ship a pricing page');
    expect(prompt).toContain('Attempt: 2/5');
    expect(prompt).toContain('Working directory: /Users/jake/repos/my-app');
  });

  it('includes computer-use guidance when a session id is present', () => {
    const prompt = buildAutonomousTaskPrompt(
      'Inspect Firefox UI',
      '/Users/jake/repos/my-app',
      1,
      5,
      undefined,
      'session-123',
    );

    expect(prompt).toContain('Use the `computer-use` MCP tools');
    expect(prompt).toContain('session-123');
  });
});

describe('buildAutonomousTaskStatusSummary', () => {
  it('formats a concise task status block', () => {
    const task: TaskState = {
      id: 'task-1',
      goal: 'Build a landing page',
      status: 'running',
      attempt: 2,
      maxAttempts: 5,
      startedAt: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-03-31T00:10:00.000Z',
      currentProject: '/Users/jake/repos/my-app',
      lastSummary: 'Implemented the hero section.',
    };

    expect(buildAutonomousTaskStatusSummary(task)).toBe(
      'Task: task-1\nStatus: running\nAttempt: 2/5\nProject: my-app\nGoal: Build a landing page\nLast summary: Implemented the hero section.',
    );
  });
});

describe('buildMainReplyKeyboard', () => {
  it('includes the guided button rows for common actions', () => {
    expect(buildMainReplyKeyboard()).toEqual({
      keyboard: [
        [{ text: 'Task' }, { text: 'Codex Chat' }, { text: 'Status' }],
        [{ text: 'Screenshot' }, { text: 'Launch App' }, { text: 'Projects' }],
        [{ text: 'Change Project' }, { text: 'Task Status' }, { text: 'Task Stop' }],
        [{ text: 'Chat Terminal' }, { text: 'End Chat' }, { text: 'Help' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    });
  });
});

describe('chat transcript helpers', () => {
  it('stores chat transcripts under the Telegram log directory', () => {
    expect(getChatTranscriptPath(123, '/Users/jake')).toBe(
      '/Users/jake/Library/Logs/telegram-bot/chat-transcripts/chat-123.log',
    );
  });

  it('builds a tail command for the local Terminal viewer', () => {
    expect(buildChatTranscriptTailCommand('/tmp/chat.log')).toContain('tail -n 200 -F');
    expect(buildChatTranscriptTailCommand('/tmp/chat.log')).toContain("'/tmp/chat.log'");
  });
});

describe('buildTelegramWebSendPhotoBookmarklet', () => {
  it('returns a bookmarklet that targets the Telegram Web send-photo modal', () => {
    const bookmarklet = buildTelegramWebSendPhotoBookmarklet();

    expect(bookmarklet.startsWith('javascript:')).toBe(true);
    expect(bookmarklet).toContain("includes('Add a caption')");
    expect(bookmarklet).toContain('button,[role="button"]');
    expect(bookmarklet).toContain("alert('Send Photo modal not found')");
    expect(bookmarklet).toContain("alert('Send button not found')");
  });
});

describe('buildTelegramConnectivitySummary', () => {
  it('identifies system-wide DNS failures', () => {
    expect(buildTelegramConnectivitySummary({
      telegramDns: {
        host: 'api.telegram.org',
        ok: false,
        errorCode: 'ENOTFOUND',
      },
      generalDns: {
        host: 'google.com',
        ok: false,
        errorCode: 'ENOTFOUND',
      },
      telegramHttps: {
        url: 'https://api.telegram.org',
        ok: false,
        errorCode: 'ENOTFOUND',
      },
    })).toBe(
      'System DNS lookup is failing beyond Telegram. Check the Mac DNS resolver, router, VPN, or firewall.',
    );
  });

  it('identifies Telegram-specific DNS failures', () => {
    expect(buildTelegramConnectivitySummary({
      telegramDns: {
        host: 'api.telegram.org',
        ok: false,
        errorCode: 'ENOTFOUND',
      },
      generalDns: {
        host: 'google.com',
        ok: true,
        address: '8.8.8.8',
        family: 4,
      },
      telegramHttps: {
        url: 'https://api.telegram.org',
        ok: false,
        errorCode: 'ENOTFOUND',
      },
    })).toBe(
      'General DNS works, but api.telegram.org does not resolve. Check DNS filtering, split-DNS, or Telegram blocking.',
    );
  });

  it('identifies HTTPS timeout failures after successful DNS', () => {
    expect(buildTelegramConnectivitySummary({
      telegramDns: {
        host: 'api.telegram.org',
        ok: true,
        address: '149.154.167.220',
        family: 4,
      },
      generalDns: {
        host: 'google.com',
        ok: true,
        address: '8.8.8.8',
        family: 4,
      },
      telegramHttps: {
        url: 'https://api.telegram.org',
        ok: false,
        errorCode: 'ETIMEDOUT',
      },
    })).toBe(
      'DNS resolves, but HTTPS to api.telegram.org is timing out or blocked on port 443.',
    );
  });
});

describe('buildCodexMcpAddArgs', () => {
  it('builds a codex mcp add command for the computer-use server', () => {
    expect(buildCodexMcpAddArgs('/tmp/server.js', 'http://127.0.0.1:4317')).toEqual([
      'mcp',
      'add',
      'computer-use',
      '--env',
      'COMPUTER_USE_HOST_URL=http://127.0.0.1:4317',
      '--',
      'node',
      '/tmp/server.js',
    ]);
  });
});

describe('isExpectedComputerUseMcpServer', () => {
  it('accepts the expected stdio server config', () => {
    expect(
      isExpectedComputerUseMcpServer(
        {
          name: 'computer-use',
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['/tmp/server.js'],
            env: {
              COMPUTER_USE_HOST_URL: 'http://127.0.0.1:4317',
            },
          },
        },
        '/tmp/server.js',
        'http://127.0.0.1:4317',
      ),
    ).toBe(true);
  });

  it('rejects mismatched server configs', () => {
    expect(
      isExpectedComputerUseMcpServer(
        {
          name: 'computer-use',
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['/tmp/other.js'],
            env: {
              COMPUTER_USE_HOST_URL: 'http://127.0.0.1:4317',
            },
          },
        },
        '/tmp/server.js',
        'http://127.0.0.1:4317',
      ),
    ).toBe(false);
  });
});
