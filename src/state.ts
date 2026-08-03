import { readFileSync, writeFileSync } from 'node:fs';

export interface ChatState {
  currentProject: string;
  chatActive: boolean;
  computerUseSessionId?: string;
  task?: TaskState;
}

export interface TaskState {
  id: string;
  goal: string;
  status: 'running' | 'completed' | 'blocked' | 'failed' | 'stopped' | 'exhausted';
  mode?: 'standard' | 'overnight';
  phase?: 'red' | 'green' | 'refactor' | 'verify';
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  updatedAt: string;
  deadlineAt?: string;
  currentProject: string;
  lastSummary?: string;
}

export interface BotState {
  lastUpdateId: number;
  lastStartTime: number;
  defaultCurrentProject: string;
  legacyChatActive: boolean;
  chatStates: Record<string, ChatState>;
}

export const DEFAULT_CHAT_STATE: ChatState = {
  currentProject: '',
  chatActive: false,
};

export const DEFAULT_STATE: BotState = {
  lastUpdateId: 0,
  lastStartTime: 0,
  defaultCurrentProject: '',
  legacyChatActive: false,
  chatStates: {},
};

export function loadState(path: string): BotState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = raw as Partial<BotState> & {
      currentProject?: unknown;
      chatActive?: unknown;
      chatStates?: Record<string, Partial<ChatState>>;
    };

    const chatStates = Object.fromEntries(
      Object.entries(parsed.chatStates ?? {}).map(([chatId, chatState]) => [
        chatId,
        {
          ...DEFAULT_CHAT_STATE,
          ...chatState,
          task: chatState?.task,
        },
      ]),
    );

    return {
      ...DEFAULT_STATE,
      ...parsed,
      defaultCurrentProject: typeof parsed.defaultCurrentProject === 'string'
        ? parsed.defaultCurrentProject
        : typeof parsed.currentProject === 'string'
          ? parsed.currentProject
          : DEFAULT_STATE.defaultCurrentProject,
      legacyChatActive: typeof parsed.legacyChatActive === 'boolean'
        ? parsed.legacyChatActive
        : typeof parsed.chatActive === 'boolean'
          ? parsed.chatActive
          : DEFAULT_STATE.legacyChatActive,
      chatStates,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(path: string, state: BotState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}
