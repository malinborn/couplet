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
// Explicit ribbon geometry, not a density field: for every column (x) each
// curtain has exactly one bright edge position (an S-curve across the full
// width, in NORMALIZED uv.x — never aspect-scaled, so the curve always
// completes the same fraction of its shape on any viewport, 400px included).
// Intensity is a function of vertical distance from that one curve — a
// crisp threshold right at the edge, an exponential decay above it — which
// is what makes it read as a ribbon instead of a density cloud. Two ribbons
// (a bright upper one behind the title/tagline, a fainter lower one under
// the install code) are drawn this way and composited by weighted colour
// average. This is the version the owner approved live ("вот, чётко") —
// do not swap it for a bloom/multi-hue variant without that same live
// sign-off; two earlier attempts at "more" (a bloom halo, a flat colour
// fill, a density-field redesign) were each rejected on sight.
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
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * noise(p);
    p *= 2.1;
    amp *= 0.5;
  }
  return v;
}

/* One curtain's bright edge as a function of x (S-curve + organic wobble),
   and the intensity of a fragment relative to that edge. localHeight is
   written out (>=0 above the bright edge) so the caller can also gate ray
   visibility and the colour ramp off the SAME curtain-relative coordinate —
   using absolute screen Y for any of that puts pink at a fixed screen
   height regardless of where a curtain's own base actually sits. */
float ribbon(vec2 uv, float t, float baseY, float ampY, float phase,
             float thickness, float foldFreq, out float localHeight) {
  float curve = sin(uv.x * 6.2831853 * 0.62 + phase + t * 0.06) * ampY;
  float wobble = (fbm(vec2(uv.x * foldFreq + phase * 3.0 + t * 0.10, phase)) - 0.5) * ampY * 0.7;
  float centerY = baseY + curve + wobble;
  float bottom = centerY - thickness * 0.5;
  localHeight = uv.y - bottom;
  float edge = smoothstep(-0.010, 0.004, localHeight); // crisp: ~0.014 of hero height
  float decay = exp(-max(localHeight, 0.0) * (2.2 / thickness));
  return edge * decay;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  float t = uTime;

  float h1, h2;
  float baseA = ribbon(uv, t, 0.66, 0.11, 0.7, 0.30, 2.0, h1);
  float baseB = ribbon(uv, t, 0.27, 0.08, 3.1, 0.22, 2.6, h2);

  // Rays: high x-frequency streaks, gated by proximity to each curtain's own
  // edge so they're crisp right at the base and taper into the smoother
  // decay glow above rather than running the full height as solid needles.
  // Floor kept high so the edge itself reads as a solid, saturated line
  // independent of ray texture — rays are a boost on top of that, not the
  // only thing putting colour on screen.
  float rayNoiseA = fbm(vec2(uv.x * 34.0 + sin(t * 0.35) * 0.4, t * 0.12));
  float raysA = pow(clamp(rayNoiseA, 0.0, 1.0), 2.6);
  float rayVisA = exp(-max(h1, 0.0) * (3.6 / 0.30));
  float structA = baseA * mix(0.65, 1.7, raysA * rayVisA);

  float rayNoiseB = fbm(vec2(uv.x * 28.0 + cos(t * 0.28) * 0.4, t * 0.09 + 5.0));
  float raysB = pow(clamp(rayNoiseB, 0.0, 1.0), 2.4);
  float rayVisB = exp(-max(h2, 0.0) * (3.6 / 0.22));
  float structB = baseB * mix(0.65, 1.6, raysB * rayVisB);

  // Ripple: a slow shimmer travelling along each curtain's own length.
  structA *= 0.85 + 0.15 * sin(uv.x * 16.0 - t * 1.4 + 0.7);
  structB *= (0.85 + 0.15 * sin(uv.x * 13.0 - t * 1.1 + 3.1)) * 0.6; // stays visibly fainter — depth, not a second lead

  vec3 oxygenLow = vec3(0.235, 0.941, 0.541);   /* #3cf08a */
  vec3 oxygenHigh = vec3(0.180, 0.902, 0.627);  /* #2ee6a0 */
  vec3 nitrogenPink = vec3(0.902, 0.310, 0.580);
  vec3 highViolet = vec3(0.514, 0.345, 0.937);

  // Colour ramp keyed off each curtain's OWN local height above its own
  // edge (not absolute screen Y) — green dominates near the base, pink/
  // violet only enter near the top of that curtain's own glow.
  float climbA = clamp(h1 / 0.30, 0.0, 1.0);
  vec3 colA = mix(oxygenLow, oxygenHigh, noise(vec2(uv.x * 4.0, t * 0.2)));
  colA = mix(colA, nitrogenPink, smoothstep(0.42, 0.80, climbA));
  colA = mix(colA, highViolet, smoothstep(0.80, 1.0, climbA));

  float climbB = clamp(h2 / 0.22, 0.0, 1.0);
  vec3 colB = mix(oxygenLow, oxygenHigh, noise(vec2(uv.x * 4.0 + 7.0, t * 0.2)));
  colB = mix(colB, nitrogenPink, smoothstep(0.55, 0.90, climbB));

  float total = structA + structB + 1e-4;
  vec3 col = (colA * structA + colB * structB) / total;
  float alpha = clamp((structA + structB) * 0.92, 0.0, 0.9);
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

  // preserveDrawingBuffer:true — without it, a screenshot taken between a
  // draw and the browser's implicit post-composite clear of a non-preserved
  // WebGL buffer can capture a near-empty canvas (measured: Playwright/CDP
  // screenshots of this canvas came back pale until this was set). Cheap at
  // this canvas's size and capped frame rate.
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null;
    if (!gl) {
      gl = canvas.getContext('experimental-webgl', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
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
