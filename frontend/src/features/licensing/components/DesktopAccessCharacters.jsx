import React from 'react';

// Animated character interaction adapted from arsh342/careercompass (MIT).

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function CharacterEye({
  size,
  pupilSize,
  blink = false,
  lookX = 0,
  lookY = 0,
  bare = false,
}) {
  if (bare) {
    return (
      <span
        className="desktop-access-character-pupil"
        style={{
          width: size,
          height: size,
          transform: `translate(${lookX}px, ${lookY}px)`,
        }}
      />
    );
  }

  return (
    <span
      className={`desktop-access-character-eye${blink ? ' is-blinking' : ''}`}
      style={{ width: size, height: blink ? 2 : size }}
    >
      {!blink ? (
        <i
          style={{
            width: pupilSize,
            height: pupilSize,
            transform: `translate(${lookX}px, ${lookY}px)`,
          }}
        />
      ) : null}
    </span>
  );
}

function useBlink() {
  const [blinking, setBlinking] = React.useState(false);

  React.useEffect(() => {
    let blinkTimer;
    let openTimer;
    let disposed = false;

    const schedule = () => {
      blinkTimer = globalThis.setTimeout(() => {
        if (disposed) return;
        setBlinking(true);
        openTimer = globalThis.setTimeout(() => {
          if (disposed) return;
          setBlinking(false);
          schedule();
        }, 145);
      }, 2800 + Math.random() * 3800);
    };

    schedule();
    return () => {
      disposed = true;
      globalThis.clearTimeout(blinkTimer);
      globalThis.clearTimeout(openTimer);
    };
  }, []);

  return blinking;
}

function characterPosition(ref, pointer) {
  if (!ref.current || !pointer.active) return { faceX: 0, faceY: 0, skew: 0 };
  const rect = ref.current.getBoundingClientRect();
  const deltaX = pointer.x - (rect.left + rect.width / 2);
  const deltaY = pointer.y - (rect.top + rect.height / 3);
  return {
    faceX: clamp(deltaX / 22, -15, 15),
    faceY: clamp(deltaY / 30, -10, 10),
    skew: clamp(-deltaX / 125, -6, 6),
  };
}

export function DesktopAccessCharacters({
  isTyping = false,
  showPassword = false,
  passwordLength = 0,
}) {
  const [pointer, setPointer] = React.useState({ x: 0, y: 0, active: false });
  const [lookingAtEachOther, setLookingAtEachOther] = React.useState(false);
  const [purplePeeking, setPurplePeeking] = React.useState(false);
  const purpleBlinking = useBlink();
  const charcoalBlinking = useBlink();
  const purpleRef = React.useRef(null);
  const charcoalRef = React.useRef(null);
  const orangeRef = React.useRef(null);
  const yellowRef = React.useRef(null);

  React.useEffect(() => {
    let frame = 0;
    let latest = null;
    const update = () => {
      frame = 0;
      if (latest) setPointer({ ...latest, active: true });
    };
    const handlePointerMove = (event) => {
      latest = { x: event.clientX, y: event.clientY };
      if (!frame) frame = globalThis.requestAnimationFrame(update);
    };
    const handlePointerLeave = () => setPointer((current) => ({ ...current, active: false }));
    globalThis.window?.addEventListener?.('pointermove', handlePointerMove);
    globalThis.window?.addEventListener?.('blur', handlePointerLeave);
    return () => {
      globalThis.window?.removeEventListener?.('pointermove', handlePointerMove);
      globalThis.window?.removeEventListener?.('blur', handlePointerLeave);
      if (frame) globalThis.cancelAnimationFrame(frame);
    };
  }, []);

  React.useEffect(() => {
    if (!isTyping) {
      setLookingAtEachOther(false);
      return undefined;
    }
    setLookingAtEachOther(true);
    const timer = globalThis.setTimeout(() => setLookingAtEachOther(false), 800);
    return () => globalThis.clearTimeout(timer);
  }, [isTyping]);

  React.useEffect(() => {
    if (!showPassword || passwordLength <= 0) {
      setPurplePeeking(false);
      return undefined;
    }
    let revealTimer;
    let hideTimer;
    const schedule = () => {
      revealTimer = globalThis.setTimeout(() => {
        setPurplePeeking(true);
        hideTimer = globalThis.setTimeout(() => {
          setPurplePeeking(false);
          schedule();
        }, 720);
      }, 1500 + Math.random() * 2300);
    };
    schedule();
    return () => {
      globalThis.clearTimeout(revealTimer);
      globalThis.clearTimeout(hideTimer);
    };
  }, [passwordLength, showPassword]);

  const purple = characterPosition(purpleRef, pointer);
  const charcoal = characterPosition(charcoalRef, pointer);
  const orange = characterPosition(orangeRef, pointer);
  const yellow = characterPosition(yellowRef, pointer);
  const hidingPassword = passwordLength > 0 && !showPassword;
  const passwordVisible = passwordLength > 0 && showPassword;

  const purpleEyes = passwordVisible
    ? { x: purplePeeking ? 4 : -4, y: purplePeeking ? 5 : -4 }
    : lookingAtEachOther
      ? { x: 3, y: 4 }
      : { x: clamp(purple.faceX / 3, -5, 5), y: clamp(purple.faceY / 2, -5, 5) };
  const charcoalEyes = passwordVisible
    ? { x: -4, y: -4 }
    : lookingAtEachOther
      ? { x: 0, y: -4 }
      : { x: clamp(charcoal.faceX / 3, -4, 4), y: clamp(charcoal.faceY / 2, -4, 4) };
  const foregroundEyes = passwordVisible
    ? { x: -5, y: -4 }
    : { x: clamp(orange.faceX / 3, -5, 5), y: clamp(orange.faceY / 2, -5, 5) };
  const yellowEyes = passwordVisible
    ? { x: -5, y: -4 }
    : { x: clamp(yellow.faceX / 3, -5, 5), y: clamp(yellow.faceY / 2, -5, 5) };

  return (
    <div
      className="desktop-access-characters"
      data-typing={isTyping ? 'true' : 'false'}
      data-password-visible={passwordVisible ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div
        ref={purpleRef}
        className="desktop-access-character desktop-access-character-purple"
        style={{
          height: isTyping || hidingPassword ? 440 : 400,
          transform: passwordVisible
            ? 'skewX(0deg)'
            : isTyping || hidingPassword
              ? `skewX(${purple.skew - 12}deg) translateX(40px)`
              : `skewX(${purple.skew}deg)`,
        }}
      >
        <div
          className="desktop-access-character-eyes desktop-access-purple-eyes"
          style={{
            left: passwordVisible ? 20 : lookingAtEachOther ? 55 : 45 + purple.faceX,
            top: passwordVisible ? 35 : lookingAtEachOther ? 65 : 40 + purple.faceY,
          }}
        >
          <CharacterEye size={18} pupilSize={7} blink={purpleBlinking} lookX={purpleEyes.x} lookY={purpleEyes.y} />
          <CharacterEye size={18} pupilSize={7} blink={purpleBlinking} lookX={purpleEyes.x} lookY={purpleEyes.y} />
        </div>
      </div>

      <div
        ref={charcoalRef}
        className="desktop-access-character desktop-access-character-charcoal"
        style={{
          transform: passwordVisible
            ? 'skewX(0deg)'
            : lookingAtEachOther
              ? `skewX(${charcoal.skew * 1.5 + 10}deg) translateX(20px)`
              : `skewX(${isTyping || hidingPassword ? charcoal.skew * 1.5 : charcoal.skew}deg)`,
        }}
      >
        <div
          className="desktop-access-character-eyes desktop-access-charcoal-eyes"
          style={{
            left: passwordVisible ? 10 : lookingAtEachOther ? 32 : 26 + charcoal.faceX,
            top: passwordVisible ? 28 : lookingAtEachOther ? 12 : 32 + charcoal.faceY,
          }}
        >
          <CharacterEye size={16} pupilSize={6} blink={charcoalBlinking} lookX={charcoalEyes.x} lookY={charcoalEyes.y} />
          <CharacterEye size={16} pupilSize={6} blink={charcoalBlinking} lookX={charcoalEyes.x} lookY={charcoalEyes.y} />
        </div>
      </div>

      <div
        ref={orangeRef}
        className="desktop-access-character desktop-access-character-orange"
        style={{ transform: passwordVisible ? 'skewX(0deg)' : `skewX(${orange.skew}deg)` }}
      >
        <div
          className="desktop-access-character-eyes desktop-access-orange-eyes"
          style={{
            left: passwordVisible ? 50 : 82 + orange.faceX,
            top: passwordVisible ? 85 : 90 + orange.faceY,
          }}
        >
          <CharacterEye bare size={12} lookX={foregroundEyes.x} lookY={foregroundEyes.y} />
          <CharacterEye bare size={12} lookX={foregroundEyes.x} lookY={foregroundEyes.y} />
        </div>
      </div>

      <div
        ref={yellowRef}
        className="desktop-access-character desktop-access-character-yellow"
        style={{ transform: passwordVisible ? 'skewX(0deg)' : `skewX(${yellow.skew}deg)` }}
      >
        <div
          className="desktop-access-character-eyes desktop-access-yellow-eyes"
          style={{
            left: passwordVisible ? 20 : 52 + yellow.faceX,
            top: passwordVisible ? 35 : 40 + yellow.faceY,
          }}
        >
          <CharacterEye bare size={12} lookX={yellowEyes.x} lookY={yellowEyes.y} />
          <CharacterEye bare size={12} lookX={yellowEyes.x} lookY={yellowEyes.y} />
        </div>
        <span
          className="desktop-access-character-mouth"
          style={{
            left: passwordVisible ? 10 : 40 + yellow.faceX,
            top: passwordVisible ? 88 : 88 + yellow.faceY,
          }}
        />
      </div>
    </div>
  );
}
