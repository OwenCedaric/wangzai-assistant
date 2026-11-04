export const WANGZAI_AMBIENT_ACTIONS = Object.freeze([
  Object.freeze({ name: 'ear-twitch', weight: 25, durationMs: 1_450 }),
  Object.freeze({ name: 'sniff', weight: 25, durationMs: 2_800 }),
  Object.freeze({ name: 'head-rest', weight: 20, durationMs: 6_600 }),
  Object.freeze({ name: 'ball-play', weight: 30, durationMs: 8_400 }),
]);

export function chooseWangzaiAmbientAction(randomValue = Math.random()) {
  const normalized = Math.min(0.999999, Math.max(0, Number(randomValue) || 0));
  const totalWeight = WANGZAI_AMBIENT_ACTIONS.reduce((sum, action) => sum + action.weight, 0);
  let cursor = normalized * totalWeight;
  for (const action of WANGZAI_AMBIENT_ACTIONS) {
    cursor -= action.weight;
    if (cursor < 0) return action;
  }
  return WANGZAI_AMBIENT_ACTIONS.at(-1);
}

export function nextWangzaiAmbientDelay(randomValue = Math.random()) {
  const normalized = Math.min(1, Math.max(0, Number(randomValue) || 0));
  return Math.round(5_200 + normalized * 6_800);
}

export function interactiveWangzaiAction(state) {
  if (state === 'typing') return 'typing';
  if (state === 'watching') return 'watching';
  return '';
}
