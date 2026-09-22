// A realistic, physically-inspired aurora borealis rendered in a WebGL
// fragment shader, shown ONLY in the site's own light theme (`aurora-light`
// on <html>) — the owner's deliberate joke: a daylight aurora, on a light
// background, played straight rather than as a wink. Dark theme keeps the
// original iridescent blob field in site/styles/landing.css untouched; this
// module REPLACES that field for light theme rather than layering on top of
// it (two overlapping auroras would just be noise).
//
// Real aurora curtains are brightest along their lower edge (the ~100km
// oxygen emission line) and fade upward into a diffuse high-altitude glow
// tinted by nitrogen (pink/magenta) and higher-oxygen (violet) lines — the
// fragment shader's vertical profile and color ramp follow that structure
// rather than an arbitrary gradient.
//
// site/CLAUDE.md's `:root[data-theme]` warning is about *CSS* scoping
// (global, can't nest under a demo card) — irrelevant here since theme
// switching is driven from JS (`setLight`), called from the same
// `setupThemeToggle().render()` in main.ts that already flips
// `data-theme` on <html>. No new CSS theme block is added.

const FRAME_INTERVAL_MS = 1000 / 30; // FPS cap — this is decorative chrome, not the point of the page.
const MAX_DPR = 1.5;

const VERTEX_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// fbm-based curtain folds (low frequency, warps x) + a separate high-frequency
// fbm sampled mostly along x for the thin vertical "rays" that run along
// field lines inside each fold. No circles, no radial falloff anywhere —
// every shape is built from noise stretched along one axis.
const FRAGMENT_SRC = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 5; i++) {
    v += amp * noise(p);
    p *= 2.05;
    amp *= 0.55;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  float aspect = max(uResolution.x / uResolution.y, 0.6);
  float drift = uTime * 0.015;

  // Curtain fold: a slow, large undulation across x, leaning with height
  // rather than running perfectly vertical — real curtains billow, they
  // don't hang flat.
  float foldN = fbm(vec2(uv.x * 1.6 * aspect + drift, uv.y * 0.6 - drift * 0.4));
  float x = uv.x * aspect + (foldN - 0.5) * 0.55;

  // Curtain density: several loose bands across the width (frequency tuned
  // so the field never collapses to one lit patch on one side and dead
  // space everywhere else), independent of the ray detail below.
  float band = fbm(vec2(x * 1.7 + drift * 0.6, uv.y * 0.35));
  band = smoothstep(0.22, 0.72, band);

  // Rays along field lines: high x-frequency, low y-frequency, with a slow
  // shimmer so individual streaks brighten and dim rather than animating as
  // a solid sheet. A softer power than a true needle-thin ray keeps texture
  // visible across most of a band instead of only in rare bright threads.
  float rayField = fbm(vec2(x * 9.0 + sin(drift * 3.0) * 0.6, uv.y * 1.4 + drift * 1.6));
  float rays = pow(clamp(rayField, 0.0, 1.0), 2.4);

  float structure = mix(band * 0.45, band, rays);

  // Vertical energy: a hard-ish cutoff near the bottom edge, a fade
  // climbing toward the top that settles out before the very top of the
  // hero — the physical brightest-at-the-base profile, with the diffuse
  // high-altitude glow given a real ceiling rather than reaching the nav.
  float groundCut = smoothstep(0.03, 0.17, uv.y);
  float skyFade = 1.0 - smoothstep(0.22, 0.80, uv.y);
  float vertical = groundCut * skyFade;

  float intensity = structure * vertical;

  vec3 oxygenLow = vec3(0.235, 0.941, 0.541);   /* #3cf08a */
  vec3 oxygenHigh = vec3(0.180, 0.902, 0.627);  /* #2ee6a0 */
  vec3 nitrogenPink = vec3(0.902, 0.310, 0.580);
  vec3 highViolet = vec3(0.514, 0.345, 0.937);

  // Green carries the bulk of the visible band; pink/violet are an accent
  // near its upper edge only, not a second dominant colour — the climb
  // thresholds are deliberately late so most of what's on screen reads
  // as oxygen green before any magenta enters the mix.
  vec3 base = mix(oxygenLow, oxygenHigh, noise(vec2(x * 2.0, drift)));
  float climb = clamp(uv.y * 1.55, 0.0, 1.0);
  vec3 col = mix(base, nitrogenPink, smoothstep(0.54, 0.86, climb));
  col = mix(col, highViolet, smoothstep(0.86, 1.0, climb));

  float alpha = clamp(intensity * 1.7, 0.0, 0.85);
  gl_FragColor = vec4(col, alpha);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export interface HeroAurora {
  /** Called whenever the site's own theme flips — shows/hides and starts/stops the shader. */
  setLight: (isLight: boolean) => void;
}

export function initHeroAurora(): HeroAurora | null {
  const maybeField = document.querySelector<HTMLElement>('.hero-aurora');
  const heroField = maybeField?.querySelector<HTMLElement>('.hero-aurora-field');
  if (!maybeField || !heroField) return null;
  // TS narrows `field` to non-null right here, but NOT inside the function
  // declarations below (they're not closures TS re-checks at call time) —
  // rebinding to an explicitly-typed const carries the non-null guarantee
  // through every one of them without a non-null assertion at each call site.
  const field: HTMLElement = maybeField;

  const canvas = document.createElement('canvas');
  canvas.className = 'hero-aurora-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  field.appendChild(canvas);

  const fallback = document.createElement('div');
  fallback.className = 'hero-aurora-fallback';
  fallback.setAttribute('aria-hidden', 'true');
  field.appendChild(fallback);

  let gl: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let uResolution: WebGLUniformLocation | null = null;
  let uTime: WebGLUniformLocation | null = null;
  let webglLost = false;

  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false }) as WebGLRenderingContext | null;
    if (!gl) {
      gl = canvas.getContext('experimental-webgl', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
      }) as WebGLRenderingContext | null;
    }
  } catch {
    gl = null;
  }

  if (gl) {
    program = createProgram(gl);
    if (program) {
      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.useProgram(program);
      uResolution = gl.getUniformLocation(program, 'uResolution');
      uTime = gl.getUniformLocation(program, 'uTime');
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
    } else {
      gl = null;
    }
  }

  canvas.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      webglLost = true;
      cancelLoop();
      applyVisibility();
    },
    false,
  );

  const supportsWebgl = () => !!(gl && program && !webglLost);

  function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  function resize(): void {
    if (!gl) return;
    const rect = field.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw(timeSeconds: number): void {
    if (!gl || !uResolution || !uTime) return;
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, timeSeconds);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  let rafId: number | null = null;
  let lastDraw = 0;
  let startTime = 0;

  function loop(now: number): void {
    rafId = requestAnimationFrame(loop);
    if (now - lastDraw < FRAME_INTERVAL_MS) return;
    lastDraw = now;
    if (startTime === 0) startTime = now;
    draw((now - startTime) / 1000);
  }

  function startLoop(): void {
    if (rafId !== null) return;
    resize();
    lastDraw = 0;
    rafId = requestAnimationFrame(loop);
  }

  function cancelLoop(): void {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // The current logical desire — "should the shader be running" — separate
  // from whether it's actually allowed to (off-screen tab, hero scrolled
  // away). Recomputed by applyVisibility() whenever either changes.
  let wantsLight = false;
  let inViewport = true; // optimistic until the observer's first callback
  let pageVisible = document.visibilityState === 'visible';

  function applyVisibility(): void {
    if (!wantsLight) {
      cancelLoop();
      field.classList.remove('is-realistic', 'is-fallback');
      return;
    }

    if (supportsWebgl()) {
      field.classList.add('is-realistic');
      field.classList.remove('is-fallback');
      resize();
      if (reducedMotion()) {
        cancelLoop();
        draw(0);
      } else if (inViewport && pageVisible) {
        startLoop();
      } else {
        cancelLoop();
      }
    } else {
      // No WebGL (or context lost): a static CSS gradient stands in — still
      // aurora-shaped, just not animated or noise-structured.
      cancelLoop();
      field.classList.add('is-fallback');
      field.classList.remove('is-realistic');
    }
  }

  const heroEl = document.getElementById('top');
  if (heroEl && typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          inViewport = entry.isIntersecting;
        }
        applyVisibility();
      },
      { threshold: 0 },
    );
    io.observe(heroEl);
  }

  document.addEventListener('visibilitychange', () => {
    pageVisible = document.visibilityState === 'visible';
    applyVisibility();
  });

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      resize();
    });
    ro.observe(field);
  } else {
    window.addEventListener('resize', resize);
  }

  const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedMq.addEventListener('change', applyVisibility);

  return {
    setLight(isLight: boolean): void {
      wantsLight = isLight;
      applyVisibility();
    },
  };
}
