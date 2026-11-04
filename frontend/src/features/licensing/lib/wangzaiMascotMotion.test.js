import { describe, expect, it } from 'vitest';
import {
  chooseWangzaiAmbientAction,
  interactiveWangzaiAction,
  nextWangzaiAmbientDelay,
} from './wangzaiMascotMotion.js';

describe('wangzaiMascotMotion', () => {
  it('selects ambient actions by stable weighted ranges', () => {
    expect(chooseWangzaiAmbientAction(0).name).toBe('ear-twitch');
    expect(chooseWangzaiAmbientAction(0.31).name).toBe('sniff');
    expect(chooseWangzaiAmbientAction(0.62).name).toBe('head-rest');
    expect(chooseWangzaiAmbientAction(0.99).name).toBe('ball-play');
  });

  it('keeps ambient delays inside the intended calm interval', () => {
    expect(nextWangzaiAmbientDelay(0)).toBe(5_200);
    expect(nextWangzaiAmbientDelay(1)).toBe(12_000);
  });

  it('gives password interaction priority over ambient actions', () => {
    expect(interactiveWangzaiAction('typing')).toBe('typing');
    expect(interactiveWangzaiAction('watching')).toBe('watching');
    expect(interactiveWangzaiAction('idle')).toBe('');
  });
});
