const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/point-DDzb10qD.js","assets/mermaid-B609I8Vk.js","assets/editor-demo-BRYhMLQt.js","assets/editor-demo-mnKoCjXC.css","assets/edit-Ct_Ptp7n.js","assets/content-diff-ZzYjSwqm.js","assets/ask-VdgRJO-Q.js","assets/comment-DJJgkitX.js","assets/anyway-Ge1WQLxd.js","assets/showcase-TRl26nQF.js"])))=>i.map(i=>d[i]);
(function(){const s=document.createElement("link").relList;if(s&&s.supports&&s.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))o(a);new MutationObserver(a=>{for(const e of a)if(e.type==="childList")for(const r of e.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&o(r)}).observe(document,{childList:!0,subtree:!0});function n(a){const e={};return a.integrity&&(e.integrity=a.integrity),a.referrerPolicy&&(e.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?e.credentials="include":a.crossOrigin==="anonymous"?e.credentials="omit":e.credentials="same-origin",e}function o(a){if(a.ep)return;a.ep=!0;const e=n(a);fetch(a.href,e)}})();const C="modulepreload",O=function(t){return"/"+t},I={},v=function(s,n,o){let a=Promise.resolve();if(n&&n.length>0){let r=function(c){return Promise.all(c.map(f=>Promise.resolve(f).then(m=>({status:"fulfilled",value:m}),m=>({status:"rejected",reason:m}))))};document.getElementsByTagName("link");const i=document.querySelector("meta[property=csp-nonce]"),u=i?.nonce||i?.getAttribute("nonce");a=r(n.map(c=>{if(c=O(c),c in I)return;I[c]=!0;const f=c.endsWith(".css"),m=f?'[rel="stylesheet"]':"";if(document.querySelector(`link[href="${c}"]${m}`))return;const l=document.createElement("link");if(l.rel=f?"stylesheet":C,f||(l.as="script"),l.crossOrigin="",l.href=c,u&&l.setAttribute("nonce",u),document.head.appendChild(l),f)return new Promise((h,E)=>{l.addEventListener("load",h),l.addEventListener("error",()=>E(new Error(`Unable to preload CSS for ${c}`)))})}))}function e(r){const i=new Event("vite:preloadError",{cancelable:!0});if(i.payload=r,window.dispatchEvent(i),!i.defaultPrevented)throw r}return a.then(r=>{for(const i of r||[])i.status==="rejected"&&e(i.reason);return s().catch(e)})},D=1e3/30,F=1.5,N=`
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`,q=`
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
`;function T(t,s,n){const o=t.createShader(s);return o?(t.shaderSource(o,n),t.compileShader(o),t.getShaderParameter(o,t.COMPILE_STATUS)?o:(t.deleteShader(o),null)):null}function V(t){const s=T(t,t.VERTEX_SHADER,N),n=T(t,t.FRAGMENT_SHADER,q);if(!s||!n)return null;const o=t.createProgram();return o?(t.attachShader(o,s),t.attachShader(o,n),t.linkProgram(o),t.getProgramParameter(o,t.LINK_STATUS)?o:(t.deleteProgram(o),null)):null}function H(){const t=document.querySelector(".hero-aurora"),s=t?.querySelector(".hero-aurora-field");if(!t||!s)return null;const n=t,o=document.createElement("canvas");o.className="hero-aurora-canvas",o.setAttribute("aria-hidden","true"),n.appendChild(o);const a=document.createElement("div");a.className="hero-aurora-fallback",a.setAttribute("aria-hidden","true"),n.appendChild(a);let e=null,r=null,i=null,u=null,c=!1;try{e=o.getContext("webgl",{alpha:!0,premultipliedAlpha:!1,antialias:!1,preserveDrawingBuffer:!0}),e||(e=o.getContext("experimental-webgl",{alpha:!0,premultipliedAlpha:!1,antialias:!1,preserveDrawingBuffer:!0}))}catch{e=null}if(e)if(r=V(e),r){const d=new Float32Array([-1,-1,1,-1,-1,1,1,1]),g=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,g),e.bufferData(e.ARRAY_BUFFER,d,e.STATIC_DRAW);const p=e.getAttribLocation(r,"aPos");e.enableVertexAttribArray(p),e.vertexAttribPointer(p,2,e.FLOAT,!1,0,0),e.useProgram(r),i=e.getUniformLocation(r,"uResolution"),u=e.getUniformLocation(r,"uTime"),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),e.clearColor(0,0,0,0)}else e=null;o.addEventListener("webglcontextlost",d=>{d.preventDefault(),c=!0,y(),A()},!1);const f=()=>!!(e&&r&&!c);function m(){return window.matchMedia("(prefers-reduced-motion: reduce)").matches}let l=Math.min(window.devicePixelRatio||1,F);function h(){if(!e)return;const d=n.getBoundingClientRect(),g=Math.max(1,Math.round(d.width*l)),p=Math.max(1,Math.round(d.height*l));(o.width!==g||o.height!==p)&&(o.width=g,o.height=p,e.viewport(0,0,g,p))}function E(d){!e||!i||!u||(e.uniform2f(i,o.width,o.height),e.uniform1f(u,d),e.clear(e.COLOR_BUFFER_BIT),e.drawArrays(e.TRIANGLE_STRIP,0,4))}let b=null,w=0,x=0;function S(d){b=requestAnimationFrame(S),!(d-w<D)&&(w=d,x===0&&(x=d),E((d-x)/1e3))}function M(){b===null&&(h(),w=0,b=requestAnimationFrame(S))}function y(){b!==null&&cancelAnimationFrame(b),b=null}let R=!1,B=!0,P=document.visibilityState==="visible";function A(){if(!R){y(),n.classList.remove("is-realistic","is-fallback");return}f()?(n.classList.add("is-realistic"),n.classList.remove("is-fallback"),h(),m()?(y(),E(0)):B&&P?M():y()):(y(),n.classList.add("is-fallback"),n.classList.remove("is-realistic"))}const k=document.getElementById("top");return k&&typeof IntersectionObserver<"u"&&new IntersectionObserver(g=>{for(const p of g)B=p.isIntersecting;A()},{threshold:0}).observe(k),document.addEventListener("visibilitychange",()=>{P=document.visibilityState==="visible",A()}),typeof ResizeObserver<"u"?new ResizeObserver(()=>{h()}).observe(n):window.addEventListener("resize",h),window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change",A),{setLight(d){R=d,A()}}}const L="couplet-site:theme",Y="brew tap malinborn/mdmini && brew trust malinborn/mdmini && brew install --cask couplet";function _(){let t=null;try{t=localStorage.getItem(L)}catch{}return t==="dark"||t==="light"?t:"auto"}function U(){return!window.matchMedia("(prefers-color-scheme: light)").matches}function $(t){return t==="auto"?"dark":t==="dark"?"light":"auto"}function z(){v(()=>import("./mermaid-B609I8Vk.js").then(t=>t.X),[]).then(t=>t.reinitializeTheme()).catch(()=>{})}function W(){const t=document.getElementById("theme-toggle"),s=t?.querySelector(".theme-toggle-label");if(!t||!s)return;const n=H();function o(e){const r=e==="auto"?U():e==="dark";document.documentElement.setAttribute("data-theme",r?"aurora-dark":"aurora-light");const i=e==="auto"?"Auto":e==="dark"?"Dark":"Light";s.textContent=i,t.setAttribute("aria-label",`Theme: ${i.toLowerCase()} (click to change)`),z(),n?.setLight(!r)}t.addEventListener("click",()=>{const e=$(_());try{e==="auto"?localStorage.removeItem(L):localStorage.setItem(L,e)}catch{}o(e)}),window.matchMedia("(prefers-color-scheme: light)").addEventListener("change",()=>{_()==="auto"&&o("auto")}),o(_())}function X(){const t=document.getElementById("copy-install"),s=t?.querySelector(".copy-btn-label");if(!t||!s)return;let n;t.addEventListener("click",()=>{navigator.clipboard.writeText(Y).then(()=>{s.textContent="Copied",clearTimeout(n),n=setTimeout(()=>{s.textContent="Copy"},1600)}).catch(()=>{})})}function j(){const t=document.getElementById("ai-carousel"),s=document.getElementById("carousel-track"),n=document.getElementById("track-inner"),o=document.getElementById("carousel-prev"),a=document.getElementById("carousel-next"),e=document.getElementById("carousel-dots");if(!t||!s||!n||!o||!a||!e)return;const r=Array.from(n.querySelectorAll(".slide")),i=Array.from(e.querySelectorAll(".carousel-dot")),u=r.length;if(u===0)return;let c=0;function f(){n.style.transform=`translateX(-${c*100}%)`,i.forEach((l,h)=>l.classList.toggle("is-active",h===c)),r.forEach((l,h)=>{h===c?l.removeAttribute("inert"):l.setAttribute("inert","")})}function m(l){c=(l%u+u)%u,f()}o.addEventListener("click",()=>m(c-1)),a.addEventListener("click",()=>m(c+1)),i.forEach((l,h)=>l.addEventListener("click",()=>m(h))),t.tabIndex=0,t.addEventListener("keydown",l=>{if(l.key==="ArrowLeft")m(c-1);else if(l.key==="ArrowRight")m(c+1);else return;l.preventDefault()}),s.classList.add("js-enabled"),s.scrollLeft=0,f()}async function G(t){switch(t){case"point":return v(()=>import("./point-DDzb10qD.js"),__vite__mapDeps([0,1,2,3]));case"edit":return v(()=>import("./edit-Ct_Ptp7n.js"),__vite__mapDeps([4,1,5,2,3]));case"ask":return v(()=>import("./ask-VdgRJO-Q.js"),__vite__mapDeps([6,1,5,2,3]));case"comment":return v(()=>import("./comment-DJJgkitX.js"),__vite__mapDeps([7,2,1,3]));case"anyway":return v(()=>import("./anyway-Ge1WQLxd.js"),__vite__mapDeps([8,2,1,3]));case"showcase":return v(()=>import("./showcase-TRl26nQF.js"),__vite__mapDeps([9,1,2,3]))}}function K(t){return t==="point"||t==="edit"||t==="ask"||t==="comment"||t==="anyway"||t==="showcase"}function J(){const t=new WeakSet;function s(r){if(t.has(r))return;t.add(r);const i=r.dataset.demoHeight;i&&r.style.setProperty("--demo-h",`${i}px`);const u=r.dataset.demo,c=r.querySelector(".demo-body")??r;K(u)&&G(u).then(f=>{c.querySelectorAll(":scope > :not(noscript)").forEach(m=>m.remove()),f.mount(c)}).catch(f=>{console.error(`[couplet] demo "${u}" failed to mount`,f)})}const n=Array.from(document.querySelectorAll("[data-demo]"));if(n.length===0)return;const o=new IntersectionObserver(r=>{for(const i of r){if(!i.isIntersecting)continue;const u=i.target;s(u),o.unobserve(u)}},{rootMargin:"200px"});for(const r of n)o.observe(r);const a=document.getElementById("ai"),e=n.find(r=>r.dataset.demo==="showcase");if(a&&e){const r=new IntersectionObserver(i=>{for(const u of i)u.isIntersecting&&(s(e),r.disconnect())},{rootMargin:"600px"});r.observe(a)}}W();X();j();J();export{v as _};
