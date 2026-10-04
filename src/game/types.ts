export type Group = 'red' | 'yellow' | 'blue';
export type BallKind = 'cue' | 'black' | Group;

export const GROUP_ORDER: readonly Group[] = ['red', 'yellow', 'blue'];

export interface Ball {
  id: number;
  kind: BallKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onTable: boolean;
}

export const GROUP_LABEL: Record<Group, { one: string; many: string }> = {
  red: { one: 'rouge', many: 'rouges' },
  yellow: { one: 'jaune', many: 'jaunes' },
  blue: { one: 'bleue', many: 'bleues' },
};

export function isGroup(k: BallKind): k is Group {
  return k === 'red' || k === 'yellow' || k === 'blue';
}
