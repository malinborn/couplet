const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/point-CRJQkANp.js","assets/mermaid-5YPmyrrH.js","assets/editor-demo-4BWUF3G7.js","assets/editor-demo-mnKoCjXC.css","assets/edit-B44umcyi.js","assets/content-diff-ZzYjSwqm.js","assets/ask-pfzu4CqC.js","assets/comment-B0DYMqf4.js","assets/anyway-BXgKCx1r.js","assets/showcase-FEpYNtW3.js"])))=>i.map(i=>d[i]);
(function(){const s=document.createElement("link").relList;if(s&&s.supports&&s.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))r(a);new MutationObserver(a=>{for(const e of a)if(e.type==="childList")for(const o of e.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&r(o)}).observe(document,{childList:!0,subtree:!0});function n(a){const e={};return a.integrity&&(e.integrity=a.integrity),a.referrerPolicy&&(e.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?e.credentials="include":a.crossOrigin==="anonymous"?e.credentials="omit":e.credentials="same-origin",e}function r(a){if(a.ep)return;a.ep=!0;const e=n(a);fetch(a.href,e)}})();const O="modulepreload",F=function(t){return"/"+t},I={},y=function(s,n,r){let a=Promise.resolve();if(n&&n.length>0){let o=function(l){return Promise.all(l.map(f=>Promise.resolve(f).then(m=>({status:"fulfilled",value:m}),m=>({status:"rejected",reason:m}))))};document.getElementsByTagName("link");const i=document.querySelector("meta[property=csp-nonce]"),u=i?.nonce||i?.getAttribute("nonce");a=o(n.map(l=>{if(l=F(l),l in I)return;I[l]=!0;const f=l.endsWith(".css"),m=f?'[rel="stylesheet"]':"";if(document.querySelector(`link[href="${l}"]${m}`))return;const c=document.createElement("link");if(c.rel=f?"stylesheet":O,f||(c.as="script"),c.crossOrigin="",c.href=l,u&&c.setAttribute("nonce",u),document.head.appendChild(c),f)return new Promise((h,E)=>{c.addEventListener("load",h),c.addEventListener("error",()=>E(new Error(`Unable to preload CSS for ${l}`)))})}))}function e(o){const i=new Event("vite:preloadError",{cancelable:!0});if(i.payload=o,window.dispatchEvent(i),!i.defaultPrevented)throw o}return a.then(o=>{for(const i of o||[])i.status==="rejected"&&e(i.reason);return s().catch(e)})},D=1e3/30,N=1.5,q=`
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`,B=`
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

/* A hand-picked "aurora green family" (teal/cyan -> emerald -> yellow-
   green) — no blue sky, no rainbow. h wraps 0..1; the two triangle-mix legs
   make a continuous cycle, so a slowly drifting h reads as colour actually
   flowing rather than snapping between fixed tones. */
vec3 auroraGreen(float h) {
  vec3 teal = vec3(0.106, 0.816, 0.788);
  vec3 emerald = vec3(0.086, 0.847, 0.475);
  vec3 yellowGreen = vec3(0.612, 0.882, 0.298);
  float p = fract(h);
  if (p < 0.5) return mix(teal, emerald, p * 2.0);
  return mix(emerald, yellowGreen, (p - 0.5) * 2.0);
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
  // Owner asked for the light to read "a bit longer" after seeing this
  // commit live — only the top of skyFade's range moved (0.80 -> 0.90),
  // so the glow persists somewhat further up before fading out. Thickness
  // and groundCut (the bottom edge) are untouched on purpose.
  float groundCut = smoothstep(0.03, 0.17, uv.y);
  float skyFade = 1.0 - smoothstep(0.22, 0.90, uv.y);
  float vertical = groundCut * skyFade;

  float intensity = structure * vertical;

  vec3 nitrogenPink = vec3(0.902, 0.310, 0.580);
  vec3 highViolet = vec3(0.514, 0.345, 0.937);

  // Green carries the bulk of the visible band; pink/violet are an accent
  // near its upper edge only, not a second dominant colour — the climb
  // thresholds are deliberately late so most of what's on screen reads
  // as green before any magenta enters the mix.
  //
  // Owner's second ask: the green itself should visibly flow rather than
  // sit at one fixed tone — auroraGreen() below is a small hand-picked
  // palette (teal/cyan -> emerald -> yellow-green, all natural aurora
  // hues, no blue sky and no rainbow) and hueN drifts slowly along x AND
  // time, so neighbouring folds land on different greens and the same
  // point in x shifts hue as the seconds pass.
  float hueN = fbm(vec2(x * 1.1 + drift * 1.3, drift * 0.9)) + 0.12 * sin(x * 2.2 - drift * 2.0);
  vec3 base = auroraGreen(hueN);
  float climb = clamp(uv.y * 1.55, 0.0, 1.0);
  vec3 col = mix(base, nitrogenPink, smoothstep(0.54, 0.86, climb));
  col = mix(col, highViolet, smoothstep(0.86, 1.0, climb));

  float alpha = clamp(intensity * 1.7, 0.0, 0.85);
  gl_FragColor = vec4(col, alpha);
}
`;function C(t,s,n){const r=t.createShader(s);return r?(t.shaderSource(r,n),t.compileShader(r),t.getShaderParameter(r,t.COMPILE_STATUS)?r:(t.deleteShader(r),null)):null}function V(t){const s=C(t,t.VERTEX_SHADER,q),n=C(t,t.FRAGMENT_SHADER,B);if(!s||!n)return null;const r=t.createProgram();return r?(t.attachShader(r,s),t.attachShader(r,n),t.linkProgram(r),t.getProgramParameter(r,t.LINK_STATUS)?r:(t.deleteProgram(r),null)):null}function U(){const t=document.querySelector(".hero-aurora"),s=t?.querySelector(".hero-aurora-field");if(!t||!s)return null;const n=t,r=document.createElement("canvas");r.className="hero-aurora-canvas",r.setAttribute("aria-hidden","true"),n.appendChild(r);const a=document.createElement("div");a.className="hero-aurora-fallback",a.setAttribute("aria-hidden","true"),n.appendChild(a);let e=null,o=null,i=null,u=null,l=!1;try{e=r.getContext("webgl",{alpha:!0,premultipliedAlpha:!1,antialias:!1}),e||(e=r.getContext("experimental-webgl",{alpha:!0,premultipliedAlpha:!1,antialias:!1}))}catch{e=null}if(e)if(o=V(e),o){const d=new Float32Array([-1,-1,1,-1,-1,1,1,1]),g=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,g),e.bufferData(e.ARRAY_BUFFER,d,e.STATIC_DRAW);const p=e.getAttribLocation(o,"aPos");e.enableVertexAttribArray(p),e.vertexAttribPointer(p,2,e.FLOAT,!1,0,0),e.useProgram(o),i=e.getUniformLocation(o,"uResolution"),u=e.getUniformLocation(o,"uTime"),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),e.clearColor(0,0,0,0)}else e=null;r.addEventListener("webglcontextlost",d=>{d.preventDefault(),l=!0,b(),w()},!1);const f=()=>!!(e&&o&&!l);function m(){return window.matchMedia("(prefers-reduced-motion: reduce)").matches}let c=Math.min(window.devicePixelRatio||1,N);function h(){if(!e)return;const d=n.getBoundingClientRect(),g=Math.max(1,Math.round(d.width*c)),p=Math.max(1,Math.round(d.height*c));(r.width!==g||r.height!==p)&&(r.width=g,r.height=p,e.viewport(0,0,g,p))}function E(d){!e||!i||!u||(e.uniform2f(i,r.width,r.height),e.uniform1f(u,d),e.clear(e.COLOR_BUFFER_BIT),e.drawArrays(e.TRIANGLE_STRIP,0,4))}let v=null,A=0,_=0;function k(d){v=requestAnimationFrame(k),!(d-A<D)&&(A=d,_===0&&(_=d),E((d-_)/1e3))}function M(){v===null&&(h(),A=0,v=requestAnimationFrame(k))}function b(){v!==null&&cancelAnimationFrame(v),v=null}let S=!1,R=!0,P=document.visibilityState==="visible";function w(){if(!S){b(),n.classList.remove("is-realistic","is-fallback");return}f()?(n.classList.add("is-realistic"),n.classList.remove("is-fallback"),h(),m()?(b(),E(0)):R&&P?M():b()):(b(),n.classList.add("is-fallback"),n.classList.remove("is-realistic"))}const T=document.getElementById("top");return T&&typeof IntersectionObserver<"u"&&new IntersectionObserver(g=>{for(const p of g)R=p.isIntersecting;w()},{threshold:0}).observe(T),document.addEventListener("visibilitychange",()=>{P=document.visibilityState==="visible",w()}),typeof ResizeObserver<"u"?new ResizeObserver(()=>{h()}).observe(n):window.addEventListener("resize",h),window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change",w),{setLight(d){S=d,w()}}}const x="couplet-site:theme",G="brew tap malinborn/mdmini && brew trust malinborn/mdmini && brew install --cask mdmini";function L(){let t=null;try{t=localStorage.getItem(x)}catch{}return t==="dark"||t==="light"?t:"auto"}function H(){return!window.matchMedia("(prefers-color-scheme: light)").matches}function $(t){return t==="auto"?"dark":t==="dark"?"light":"auto"}function z(){y(()=>import("./mermaid-5YPmyrrH.js").then(t=>t.X),[]).then(t=>t.reinitializeTheme()).catch(()=>{})}function W(){const t=document.getElementById("theme-toggle"),s=t?.querySelector(".theme-toggle-label");if(!t||!s)return;const n=U();function r(e){const o=e==="auto"?H():e==="dark";document.documentElement.setAttribute("data-theme",o?"aurora-dark":"aurora-light");const i=e==="auto"?"Auto":e==="dark"?"Dark":"Light";s.textContent=i,t.setAttribute("aria-label",`Theme: ${i.toLowerCase()} (click to change)`),z(),n?.setLight(!o)}t.addEventListener("click",()=>{const e=$(L());try{e==="auto"?localStorage.removeItem(x):localStorage.setItem(x,e)}catch{}r(e)}),window.matchMedia("(prefers-color-scheme: light)").addEventListener("change",()=>{L()==="auto"&&r("auto")}),r(L())}function X(){const t=document.getElementById("copy-install"),s=t?.querySelector(".copy-btn-label");if(!t||!s)return;let n;t.addEventListener("click",()=>{navigator.clipboard.writeText(G).then(()=>{s.textContent="Copied",clearTimeout(n),n=setTimeout(()=>{s.textContent="Copy"},1600)}).catch(()=>{})})}function j(){const t=document.getElementById("ai-carousel"),s=document.getElementById("carousel-track"),n=document.getElementById("track-inner"),r=document.getElementById("carousel-prev"),a=document.getElementById("carousel-next"),e=document.getElementById("carousel-dots");if(!t||!s||!n||!r||!a||!e)return;const o=Array.from(n.querySelectorAll(".slide")),i=Array.from(e.querySelectorAll(".carousel-dot")),u=o.length;if(u===0)return;let l=0;function f(){n.style.transform=`translateX(-${l*100}%)`,i.forEach((c,h)=>c.classList.toggle("is-active",h===l)),o.forEach((c,h)=>{h===l?c.removeAttribute("inert"):c.setAttribute("inert","")})}function m(c){l=(c%u+u)%u,f()}r.addEventListener("click",()=>m(l-1)),a.addEventListener("click",()=>m(l+1)),i.forEach((c,h)=>c.addEventListener("click",()=>m(h))),t.tabIndex=0,t.addEventListener("keydown",c=>{if(c.key==="ArrowLeft")m(l-1);else if(c.key==="ArrowRight")m(l+1);else return;c.preventDefault()}),s.classList.add("js-enabled"),s.scrollLeft=0,f()}async function K(t){switch(t){case"point":return y(()=>import("./point-CRJQkANp.js"),__vite__mapDeps([0,1,2,3]));case"edit":return y(()=>import("./edit-B44umcyi.js"),__vite__mapDeps([4,1,5,2,3]));case"ask":return y(()=>import("./ask-pfzu4CqC.js"),__vite__mapDeps([6,1,5,2,3]));case"comment":return y(()=>import("./comment-B0DYMqf4.js"),__vite__mapDeps([7,2,1,3]));case"anyway":return y(()=>import("./anyway-BXgKCx1r.js"),__vite__mapDeps([8,2,1,3]));case"showcase":return y(()=>import("./showcase-FEpYNtW3.js"),__vite__mapDeps([9,1,2,3]))}}function Y(t){return t==="point"||t==="edit"||t==="ask"||t==="comment"||t==="anyway"||t==="showcase"}function J(){const t=new WeakSet;function s(o){if(t.has(o))return;t.add(o);const i=o.dataset.demoHeight;i&&o.style.setProperty("--demo-h",`${i}px`);const u=o.dataset.demo,l=o.querySelector(".demo-body")??o;Y(u)&&K(u).then(f=>{l.querySelectorAll(":scope > :not(noscript)").forEach(m=>m.remove()),f.mount(l)}).catch(f=>{console.error(`[couplet] demo "${u}" failed to mount`,f)})}const n=Array.from(document.querySelectorAll("[data-demo]"));if(n.length===0)return;const r=new IntersectionObserver(o=>{for(const i of o){if(!i.isIntersecting)continue;const u=i.target;s(u),r.unobserve(u)}},{rootMargin:"200px"});for(const o of n)r.observe(o);const a=document.getElementById("ai"),e=n.find(o=>o.dataset.demo==="showcase");if(a&&e){const o=new IntersectionObserver(i=>{for(const u of i)u.isIntersecting&&(s(e),o.disconnect())},{rootMargin:"600px"});o.observe(a)}}W();X();j();J();export{y as _};
