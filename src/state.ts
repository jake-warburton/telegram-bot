import { readFileSync, writeFileSync } from 'node:fs';

export interface BotState {
  currentProject: string;
  lastUpdateId: number;
  lastStartTime: number;
  chatActive: boolean;
}

export const DEFAULT_STATE: BotState = {
  currentProject: '',
  lastUpdateId: 0,
  lastStartTime: 0,
  chatActive: false,
};

export function loadState(path: string): BotState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(path: string, state: BotState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}
