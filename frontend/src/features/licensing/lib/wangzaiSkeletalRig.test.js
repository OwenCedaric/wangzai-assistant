import { describe, expect, it } from 'vitest';
import {
  createWangzaiMesh,
  deformWangzaiVertex,
  getWangzaiBonePose,
} from './wangzaiSkeletalRig.js';

describe('wangzaiSkeletalRig', () => {
  it('builds a continuous indexed skin mesh instead of a pose slideshow', () => {
    const mesh = createWangzaiMesh(8, 6);

    expect(mesh.positions).toHaveLength(9 * 7 * 2);
    expect(mesh.textureCoordinates).toHaveLength(mesh.positions.length);
    expect(mesh.indices).toHaveLength(8 * 6 * 6);
    expect([...mesh.indices].every((index) => index < 9 * 7)).toBe(true);
  });

  it('lowers the head through the head and neck bones while keeping the rear body stable', () => {
    const idleBones = getWangzaiBonePose({ elapsedMs: 0 });
    const restBones = getWangzaiBonePose({
      elapsedMs: 0,
      action: 'head-rest',
      actionElapsedMs: 3_300,
    });
    const idleHead = deformWangzaiVertex(870, 405, idleBones);
    const restingHead = deformWangzaiVertex(870, 405, restBones);
    const idleRear = deformWangzaiVertex(255, 720, idleBones);
    const restingRear = deformWangzaiVertex(255, 720, restBones);

    expect(restingHead.y - idleHead.y).toBeGreaterThan(18);
    expect(Math.abs(restingRear.y - idleRear.y)).toBeLessThan(2);
    expect(restBones.map((bone) => bone.name)).toEqual(expect.arrayContaining([
      'pelvis',
      'ribcage',
      'neck',
      'head',
      'left-eye',
      'right-eye',
      'left-ear',
      'right-ear',
      'near-foreleg',
      'far-foreleg',
    ]));
  });

  it('raises the foreleg nearest the tennis ball while the rear body stays stable', () => {
    const idleBones = getWangzaiBonePose({ elapsedMs: 0 });
    const playBones = getWangzaiBonePose({
      elapsedMs: 0,
      action: 'ball-play',
      actionElapsedMs: 4_800,
    });
    const idlePaw = deformWangzaiVertex(900, 880, idleBones);
    const tappingPaw = deformWangzaiVertex(900, 880, playBones);
    const idleRear = deformWangzaiVertex(260, 730, idleBones);
    const playingRear = deformWangzaiVertex(260, 730, playBones);

    expect(tappingPaw.y).toBeLessThan(idlePaw.y - 24);
    expect(tappingPaw.x).toBeGreaterThan(idlePaw.x + 16);
    expect(Math.abs(playingRear.y - idleRear.y)).toBeLessThan(2);
  });

  it('leans the head down and toward the foreground tennis ball before tapping it', () => {
    const idleBones = getWangzaiBonePose({ elapsedMs: 0 });
    const inspectingBones = getWangzaiBonePose({
      elapsedMs: 0,
      action: 'ball-play',
      actionElapsedMs: 2_800,
    });
    const idleHead = deformWangzaiVertex(870, 405, idleBones);
    const inspectingHead = deformWangzaiVertex(870, 405, inspectingBones);
    const idleEarTip = deformWangzaiVertex(1_010, 170, idleBones);
    const inspectingEarTip = deformWangzaiVertex(1_010, 170, inspectingBones);

    expect(inspectingHead.y - idleHead.y).toBeGreaterThan(70);
    expect(inspectingHead.x - idleHead.x).toBeGreaterThan(8);
    expect(inspectingEarTip.y - idleEarTip.y).toBeGreaterThan(60);
  });
});
