import React from 'react';
import mascotBase from '../assets/wangzai-smile-balanced-white.png';
import mascotBlink from '../assets/wangzai-blink.png';
import {
  chooseWangzaiAmbientAction,
  interactiveWangzaiAction,
  nextWangzaiAmbientDelay,
} from '../lib/wangzaiMascotMotion.js';
import { mountWangzaiSkeletalRig } from '../lib/wangzaiSkeletalRig.js';

function useAmbientAction(enabled) {
  const [ambientAction, setAmbientAction] = React.useState('idle');

  React.useEffect(() => {
    if (!enabled) {
      setAmbientAction('idle');
      return undefined;
    }

    let nextActionTimer = 0;
    let finishActionTimer = 0;
    const schedule = () => {
      nextActionTimer = globalThis.setTimeout(() => {
        const selected = chooseWangzaiAmbientAction();
        setAmbientAction(selected.name);
        finishActionTimer = globalThis.setTimeout(() => {
          setAmbientAction('idle');
          schedule();
        }, selected.durationMs);
      }, nextWangzaiAmbientDelay());
    };
    schedule();

    return () => {
      globalThis.clearTimeout(nextActionTimer);
      globalThis.clearTimeout(finishActionTimer);
    };
  }, [enabled]);

  return ambientAction;
}

export function WangzaiMascot({ state = 'idle' }) {
  const canvasRef = React.useRef(null);
  const rigRef = React.useRef(null);
  const [rigReady, setRigReady] = React.useState(false);
  const interactiveAction = interactiveWangzaiAction(state);
  const ambientAction = useAmbientAction(!interactiveAction);
  const action = interactiveAction || ambientAction;

  React.useEffect(() => {
    if (!canvasRef.current || typeof globalThis.WebGLRenderingContext === 'undefined') {
      return undefined;
    }
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const rig = mountWangzaiSkeletalRig(canvasRef.current, {
      awakeSource: mascotBase,
      blinkSource: mascotBlink,
      reducedMotion,
      onReady: setRigReady,
    });
    rigRef.current = rig;

    const followPointer = (event) => {
      const normalizedX = ((event.clientX / Math.max(globalThis.innerWidth, 1)) * 2) - 1;
      const normalizedY = ((event.clientY / Math.max(globalThis.innerHeight, 1)) * 2) - 1;
      rig.setPointer(normalizedX, normalizedY);
    };
    globalThis.addEventListener('pointermove', followPointer, { passive: true });

    return () => {
      globalThis.removeEventListener('pointermove', followPointer);
      rig.destroy();
      rigRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    rigRef.current?.setMode({ action, state });
  }, [action, state]);

  return (
    <div
      className={`wangzai-mascot is-${state} action-${action}${rigReady ? ' rig-ready' : ''}`}
      data-action={action}
      data-rig="webgl-skeletal-skinning"
      aria-hidden="true"
    >
      <svg className="wangzai-prop-rig" viewBox="0 0 1429 1100" focusable="false">
        <defs>
          <radialGradient id="wangzai-tennis-felt" cx="34%" cy="26%" r="72%">
            <stop offset="0%" stopColor="#efff8a" />
            <stop offset="52%" stopColor="#c7eb3f" />
            <stop offset="100%" stopColor="#8dbd1f" />
          </radialGradient>
          <filter id="wangzai-tennis-softness" x="-25%" y="-25%" width="150%" height="150%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" result="softAlpha" />
            <feSpecularLighting
              in="softAlpha"
              surfaceScale="1.4"
              specularConstant="0.38"
              specularExponent="12"
              lightingColor="#ffffff"
              result="specular"
            >
              <feDistantLight azimuth="225" elevation="52" />
            </feSpecularLighting>
            <feComposite in="specular" in2="SourceAlpha" operator="in" result="specularClip" />
            <feMerge>
              <feMergeNode in="SourceGraphic" />
              <feMergeNode in="specularClip" />
            </feMerge>
          </filter>
        </defs>
        <g className="wangzai-ball-track">
          <ellipse className="wangzai-tennis-shadow" cx="54" cy="105" rx="43" ry="12" />
          <g className="wangzai-tennis-ball" filter="url(#wangzai-tennis-softness)">
            <circle cx="54" cy="54" r="50" fill="url(#wangzai-tennis-felt)" />
            <path className="wangzai-tennis-seam" d="M 17 16 C 49 27, 51 78, 19 92" />
            <path className="wangzai-tennis-seam" d="M 91 16 C 59 27, 57 78, 89 92" />
            <circle className="wangzai-tennis-felt-grain" cx="54" cy="54" r="47" />
          </g>
        </g>
      </svg>

      <img className="wangzai-mascot-body wangzai-rig-fallback" src={mascotBase} alt="" />
      <canvas ref={canvasRef} className="wangzai-skeletal-canvas" />

      <svg className="wangzai-gaze-rig" viewBox="0 0 1429 1100" focusable="false">
        <g className="wangzai-natural-gaze">
          <g className="wangzai-eye-bone wangzai-eye-bone-left">
            <ellipse className="wangzai-pupil wangzai-pupil-left" cx="724" cy="438" rx="9" ry="11" />
            <circle className="wangzai-eye-glint" cx="721" cy="434" r="2.2" />
          </g>
          <g className="wangzai-eye-bone wangzai-eye-bone-right">
            <ellipse className="wangzai-pupil wangzai-pupil-right" cx="971" cy="402" rx="9" ry="11" />
            <circle className="wangzai-eye-glint" cx="968" cy="398" r="2.2" />
          </g>
        </g>
      </svg>
    </div>
  );
}
