const SOURCE_WIDTH = 1429;
const SOURCE_HEIGHT = 1100;
const GRID_COLUMNS = 56;
const GRID_ROWS = 44;

const ACTION_DURATION = Object.freeze({
  'ear-twitch': 1_450,
  sniff: 2_800,
  'head-rest': 6_600,
  'ball-play': 8_400,
});

const clamp = (value, minimum = 0, maximum = 1) => (
  Math.min(maximum, Math.max(minimum, value))
);

const smoothstep = (edge0, edge1, value) => {
  const normalized = clamp((value - edge0) / (edge1 - edge0));
  return normalized * normalized * (3 - (2 * normalized));
};

const pulse = (progress, start, peak, end) => {
  if (progress <= start || progress >= end) return 0;
  if (progress < peak) return smoothstep(start, peak, progress);
  return 1 - smoothstep(peak, end, progress);
};

const degrees = (value) => value * (Math.PI / 180);

function ellipseWeight(x, y, bone) {
  const dx = (x - bone.centerX) / bone.radiusX;
  const dy = (y - bone.centerY) / bone.radiusY;
  const distance = Math.sqrt((dx * dx) + (dy * dy));
  if (distance >= 1) return 0;
  const edge = 1 - distance;
  return edge * edge * (3 - (2 * edge));
}

function applyBone(point, bone) {
  const weight = ellipseWeight(point.x, point.y, bone) * (bone.strength ?? 1);
  if (weight <= 0) return point;

  const angle = degrees(bone.rotation || 0);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const localX = point.x - bone.pivotX;
  const localY = point.y - bone.pivotY;
  const scaleX = bone.scaleX ?? 1;
  const scaleY = bone.scaleY ?? 1;
  const transformedX = bone.pivotX
    + ((localX * scaleX * cosine) - (localY * scaleY * sine))
    + (bone.translateX || 0);
  const transformedY = bone.pivotY
    + ((localX * scaleX * sine) + (localY * scaleY * cosine))
    + (bone.translateY || 0);

  return {
    x: point.x + ((transformedX - point.x) * weight),
    y: point.y + ((transformedY - point.y) * weight),
  };
}

export function createWangzaiMesh(columns = GRID_COLUMNS, rows = GRID_ROWS) {
  const positions = new Float32Array((columns + 1) * (rows + 1) * 2);
  const textureCoordinates = new Float32Array(positions.length);
  const indices = new Uint16Array(columns * rows * 6);
  let vertexOffset = 0;

  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const v = row / rows;
      positions[vertexOffset] = u * SOURCE_WIDTH;
      positions[vertexOffset + 1] = v * SOURCE_HEIGHT;
      textureCoordinates[vertexOffset] = u;
      textureCoordinates[vertexOffset + 1] = v;
      vertexOffset += 2;
    }
  }

  let indexOffset = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = (row * (columns + 1)) + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns + 1;
      const bottomRight = bottomLeft + 1;
      indices.set([
        topLeft, bottomLeft, topRight,
        topRight, bottomLeft, bottomRight,
      ], indexOffset);
      indexOffset += 6;
    }
  }

  return {
    columns,
    rows,
    positions,
    textureCoordinates,
    indices,
  };
}

export function getWangzaiBonePose({
  elapsedMs = 0,
  action = 'idle',
  actionElapsedMs = 0,
  state = 'idle',
  pointerX = 0,
  pointerY = 0,
} = {}) {
  const seconds = elapsedMs / 1_000;
  const breath = Math.sin((seconds * Math.PI * 2) / 3.35);
  const slowWeightShift = Math.sin((seconds * Math.PI * 2) / 7.8);
  const earLife = Math.sin((seconds * Math.PI * 2) / 5.2);
  const duration = ACTION_DURATION[action] || 1;
  const progress = clamp(actionElapsedMs / duration);

  let headX = pointerX * 2.8;
  let headY = pointerY * 1.5;
  let headRotation = (slowWeightShift * 0.38) + (pointerX * 0.72);
  let chestDrop = 0;
  let nearPawLift = 0;
  let farPawLift = 0;
  let headScaleX = 1;
  let headScaleY = 1;
  let eyeLookX = 0;
  let eyeLookY = 0;
  let leftEarRotation = earLife * 0.32;
  let rightEarRotation = -earLife * 0.22;

  if (state === 'watching') {
    headX += 5 + (Math.sin(seconds * 1.7) * 1.2);
    headY += 2;
    headRotation += 1.15;
    rightEarRotation -= 0.7;
  } else if (state === 'typing') {
    headX += 5 + (Math.sin(seconds * 4.8) * 1.4);
    headY += 2.5 + (Math.sin(seconds * 3.7) * 0.8);
    headRotation += 1.25 + (Math.sin(seconds * 2.9) * 0.3);
    leftEarRotation += Math.sin(seconds * 5.4) * 0.45;
  }

  if (action === 'ear-twitch') {
    const twitch = pulse(progress, 0.08, 0.32, 0.72) * Math.sin(progress * Math.PI * 7);
    leftEarRotation += twitch * 4.8;
    rightEarRotation -= twitch * 2.7;
    headRotation -= twitch * 0.32;
  }

  if (action === 'sniff') {
    const lean = pulse(progress, 0.04, 0.25, 0.94);
    const sniff = Math.sin(progress * Math.PI * 12) * lean;
    headX += lean * 7;
    headY += (lean * 11) + (sniff * 2.7);
    headRotation += (lean * 1.1) + (sniff * 0.18);
    chestDrop += lean * 2.4;
  }

  if (action === 'head-rest') {
    const settle = progress < 0.24
      ? smoothstep(0.03, 0.24, progress)
      : (1 - smoothstep(0.76, 0.97, progress));
    headX += settle * 3;
    headY += settle * (27 + (breath * 1.2));
    headRotation += settle * 1.45;
    chestDrop += settle * 5.5;
    nearPawLift -= settle * 2;
  }

  if (action === 'ball-play') {
    const inspect = pulse(progress, 0.06, 0.3, 0.88);
    const sniffAtBall = Math.sin(progress * Math.PI * 18) * pulse(progress, 0.27, 0.39, 0.53);
    const tap = pulse(progress, 0.46, 0.56, 0.7);
    // The tennis ball crosses the foreground on the dog's lower-right side.
    // Move the whole neck/head chain toward it instead of only shifting pupils,
    // then slightly shorten the face to sell a real downward head pitch.
    headX += inspect * 15;
    headY += (inspect * 118) + (sniffAtBall * 7.2);
    headRotation += (inspect * 5) + (sniffAtBall * 0.34);
    headScaleX += inspect * 0.018;
    headScaleY -= inspect * 0.068;
    eyeLookX += inspect * 6;
    eyeLookY += inspect * 16;
    chestDrop += inspect * 12;
    nearPawLift += (tap * 110) - (inspect * 2.5);
    farPawLift += tap * 14;
    leftEarRotation += inspect * 0.7;
    rightEarRotation -= inspect * 1.3;
  }

  return [
    {
      name: 'pelvis',
      centerX: 500,
      centerY: 710,
      radiusX: 520,
      radiusY: 330,
      pivotX: 530,
      pivotY: 870,
      rotation: slowWeightShift * 0.1,
      translateY: breath * -1.2,
      scaleY: 1 + (breath * 0.0025),
    },
    {
      name: 'ribcage',
      centerX: 790,
      centerY: 675,
      radiusX: 390,
      radiusY: 310,
      pivotX: 790,
      pivotY: 850,
      translateY: (breath * -3.2) + chestDrop,
      scaleX: 1 + (breath * 0.0055),
      scaleY: 1 + (breath * 0.009),
      strength: 0.92,
    },
    {
      name: 'left-eye',
      centerX: 724,
      centerY: 438,
      radiusX: 72,
      radiusY: 62,
      pivotX: 724,
      pivotY: 438,
      translateX: eyeLookX,
      translateY: eyeLookY,
      strength: 0.92,
    },
    {
      name: 'right-eye',
      centerX: 971,
      centerY: 402,
      radiusX: 72,
      radiusY: 62,
      pivotX: 971,
      pivotY: 402,
      translateX: eyeLookX,
      translateY: eyeLookY,
      strength: 0.92,
    },
    {
      name: 'neck',
      centerX: 895,
      centerY: 570,
      radiusX: 300,
      radiusY: 260,
      pivotX: 825,
      pivotY: 650,
      rotation: headRotation * 0.42,
      translateX: headX * 0.45,
      translateY: headY * 0.5,
    },
    {
      name: 'head',
      centerX: 870,
      centerY: 405,
      radiusX: 330,
      radiusY: 305,
      pivotX: 835,
      pivotY: 610,
      rotation: headRotation,
      translateX: headX,
      translateY: headY,
      scaleX: headScaleX,
      scaleY: headScaleY,
    },
    {
      name: 'left-ear',
      centerX: 624,
      centerY: 210,
      radiusX: 125,
      radiusY: 210,
      pivotX: 676,
      pivotY: 350,
      rotation: leftEarRotation + (headRotation * 0.82),
      translateX: headX * 0.86,
      translateY: headY * 0.82,
    },
    {
      name: 'right-ear',
      centerX: 1_010,
      centerY: 170,
      radiusX: 130,
      radiusY: 220,
      pivotX: 970,
      pivotY: 330,
      rotation: rightEarRotation + (headRotation * 0.82),
      translateX: headX * 0.86,
      translateY: headY * 0.82,
    },
    {
      name: 'near-foreleg',
      centerX: 865,
      centerY: 845,
      radiusX: 250,
      radiusY: 220,
      pivotX: 760,
      pivotY: 710,
      rotation: nearPawLift * -0.1,
      translateX: nearPawLift * 0.12,
      translateY: nearPawLift * -0.18,
    },
    {
      name: 'far-foreleg',
      centerX: 1_180,
      centerY: 820,
      radiusX: 270,
      radiusY: 245,
      pivotX: 1_045,
      pivotY: 690,
      rotation: farPawLift * -0.08,
      translateX: farPawLift * 0.08,
      translateY: farPawLift * -0.26,
    },
  ];
}

export function deformWangzaiVertex(x, y, bones) {
  return bones.reduce((point, bone) => applyBone(point, bone), { x, y });
}

export function deformWangzaiMesh(sourcePositions, bones, target = new Float32Array(sourcePositions.length)) {
  for (let index = 0; index < sourcePositions.length; index += 2) {
    const point = deformWangzaiVertex(sourcePositions[index], sourcePositions[index + 1], bones);
    target[index] = point.x;
    target[index + 1] = point.y;
  }
  return target;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WebGL shader compile failed';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec2 a_position;
    attribute vec2 a_texture;
    uniform vec2 u_resolution;
    varying vec2 v_texture;
    void main() {
      vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_texture = a_texture;
    }
  `);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D u_awake;
    uniform sampler2D u_blink;
    uniform float u_blink_mix;
    varying vec2 v_texture;
    void main() {
      vec4 awake = texture2D(u_awake, v_texture);
      vec4 blink = texture2D(u_blink, v_texture);
      gl_FragColor = mix(awake, blink, u_blink_mix);
    }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WebGL program link failed';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load mascot texture: ${source}`));
    image.src = source;
  });
}

function createTexture(gl, image, textureUnit) {
  const texture = gl.createTexture();
  gl.activeTexture(textureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  return texture;
}

function blinkMix(elapsedMs, action, actionElapsedMs) {
  if (action === 'head-rest') {
    const restProgress = clamp(actionElapsedMs / ACTION_DURATION['head-rest']);
    const rest = restProgress < 0.24
      ? smoothstep(0.12, 0.24, restProgress)
      : (1 - smoothstep(0.76, 0.91, restProgress));
    return rest * 0.88;
  }
  const phase = (elapsedMs % 5_650) / 5_650;
  const firstBlink = pulse(phase, 0.72, 0.738, 0.758);
  const secondBlink = pulse(phase, 0.774, 0.789, 0.807);
  return Math.max(firstBlink, secondBlink);
}

function resizeCanvas(canvas, gl) {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

export function mountWangzaiSkeletalRig(canvas, {
  awakeSource,
  blinkSource,
  onReady,
  reducedMotion = false,
} = {}) {
  let disposed = false;
  let animationFrame = 0;
  let resizeObserver;
  let mode = { action: 'idle', state: 'idle', startedAt: performance.now() };
  let pointerTarget = { x: 0, y: 0 };
  let pointerCurrent = { x: 0, y: 0 };
  let renderFrame = () => {};

  let gl;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
  } catch {
    gl = null;
  }

  if (!gl) {
    onReady?.(false);
    return {
      setMode(nextMode) { mode = { ...mode, ...nextMode }; },
      setPointer() {},
      destroy() {},
    };
  }

  const mesh = createWangzaiMesh();
  const deformedPositions = new Float32Array(mesh.positions.length);

  Promise.all([loadImage(awakeSource), loadImage(blinkSource)])
    .then(([awakeImage, blinkImage]) => {
      if (disposed) return;
      const program = createProgram(gl);
      const positionBuffer = gl.createBuffer();
      const textureBuffer = gl.createBuffer();
      const indexBuffer = gl.createBuffer();
      const awakeTexture = createTexture(gl, awakeImage, gl.TEXTURE0);
      const blinkTexture = createTexture(gl, blinkImage, gl.TEXTURE1);

      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      const textureLocation = gl.getAttribLocation(program, 'a_texture');
      const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
      const blinkMixLocation = gl.getUniformLocation(program, 'u_blink_mix');
      gl.uniform1i(gl.getUniformLocation(program, 'u_awake'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_blink'), 1);
      gl.uniform2f(resolutionLocation, SOURCE_WIDTH, SOURCE_HEIGHT);

      gl.bindBuffer(gl.ARRAY_BUFFER, textureBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.textureCoordinates, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(textureLocation);
      gl.vertexAttribPointer(textureLocation, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

      const startedAt = performance.now();
      const draw = (now) => {
        if (disposed) return;
        resizeCanvas(canvas, gl);
        pointerCurrent = {
          x: pointerCurrent.x + ((pointerTarget.x - pointerCurrent.x) * 0.055),
          y: pointerCurrent.y + ((pointerTarget.y - pointerCurrent.y) * 0.055),
        };
        const elapsedMs = now - startedAt;
        const actionElapsedMs = now - mode.startedAt;
        const bones = getWangzaiBonePose({
          elapsedMs,
          action: mode.action,
          actionElapsedMs,
          state: mode.state,
          pointerX: pointerCurrent.x,
          pointerY: pointerCurrent.y,
        });
        deformWangzaiMesh(mesh.positions, bones, deformedPositions);

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, deformedPositions, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1f(blinkMixLocation, blinkMix(elapsedMs, mode.action, actionElapsedMs));
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);

        if (!reducedMotion) animationFrame = globalThis.requestAnimationFrame(draw);
      };
      renderFrame = () => draw(performance.now());

      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
          if (reducedMotion) renderFrame();
        });
        resizeObserver.observe(canvas);
      }

      onReady?.(true);
      renderFrame();

      const release = () => {
        globalThis.cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();
        gl.deleteTexture(awakeTexture);
        gl.deleteTexture(blinkTexture);
        gl.deleteBuffer(positionBuffer);
        gl.deleteBuffer(textureBuffer);
        gl.deleteBuffer(indexBuffer);
        gl.deleteProgram(program);
      };
      if (disposed) release();
      else renderFrame.release = release;
    })
    .catch(() => {
      if (!disposed) onReady?.(false);
    });

  return {
    setMode(nextMode) {
      const nextAction = nextMode.action || 'idle';
      const nextState = nextMode.state || 'idle';
      if (nextAction !== mode.action) {
        mode = { action: nextAction, state: nextState, startedAt: performance.now() };
      } else {
        mode = { ...mode, state: nextState };
      }
      if (reducedMotion) renderFrame();
    },
    setPointer(x, y) {
      pointerTarget = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    },
    destroy() {
      disposed = true;
      globalThis.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      renderFrame.release?.();
    },
  };
}

export const WANGZAI_RIG_SIZE = Object.freeze({
  width: SOURCE_WIDTH,
  height: SOURCE_HEIGHT,
});
