const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/point-C0hTxFMh.js","assets/mermaid-9kxwM34A.js","assets/editor-demo-DAnqNgJ4.js","assets/editor-demo-mnKoCjXC.css","assets/edit-BfP_11Hi.js","assets/content-diff-ZzYjSwqm.js","assets/ask-D8yszt1I.js","assets/comment-vqI3HZjZ.js","assets/anyway-CZxAY9x-.js","assets/showcase-B1lTjOpA.js"])))=>i.map(i=>d[i]);
(function(){const s=document.createElement("link").relList;if(s&&s.supports&&s.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))r(i);new MutationObserver(i=>{for(const e of i)if(e.type==="childList")for(const o of e.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&r(o)}).observe(document,{childList:!0,subtree:!0});function n(i){const e={};return i.integrity&&(e.integrity=i.integrity),i.referrerPolicy&&(e.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?e.credentials="include":i.crossOrigin==="anonymous"?e.credentials="omit":e.credentials="same-origin",e}function r(i){if(i.ep)return;i.ep=!0;const e=n(i);fetch(i.href,e)}})();const O="modulepreload",F=function(t){return"/"+t},k={},v=function(s,n,r){let i=Promise.resolve();if(n&&n.length>0){let o=function(c){return Promise.all(c.map(f=>Promise.resolve(f).then(m=>({status:"fulfilled",value:m}),m=>({status:"rejected",reason:m}))))};document.getElementsByTagName("link");const a=document.querySelector("meta[property=csp-nonce]"),u=a?.nonce||a?.getAttribute("nonce");i=o(n.map(c=>{if(c=F(c),c in k)return;k[c]=!0;const f=c.endsWith(".css"),m=f?'[rel="stylesheet"]':"";if(document.querySelector(`link[href="${c}"]${m}`))return;const l=document.createElement("link");if(l.rel=f?"stylesheet":O,f||(l.as="script"),l.crossOrigin="",l.href=c,u&&l.setAttribute("nonce",u),document.head.appendChild(l),f)return new Promise((h,w)=>{l.addEventListener("load",h),l.addEventListener("error",()=>w(new Error(`Unable to preload CSS for ${c}`)))})}))}function e(o){const a=new Event("vite:preloadError",{cancelable:!0});if(a.payload=o,window.dispatchEvent(a),!a.defaultPrevented)throw o}return i.then(o=>{for(const a of o||[])a.status==="rejected"&&e(a.reason);return s().catch(e)})},D=1e3/30,q=1.5,B=`
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`,N=`
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
`;function C(t,s,n){const r=t.createShader(s);return r?(t.shaderSource(r,n),t.compileShader(r),t.getShaderParameter(r,t.COMPILE_STATUS)?r:(t.deleteShader(r),null)):null}function V(t){const s=C(t,t.VERTEX_SHADER,B),n=C(t,t.FRAGMENT_SHADER,N);if(!s||!n)return null;const r=t.createProgram();return r?(t.attachShader(r,s),t.attachShader(r,n),t.linkProgram(r),t.getProgramParameter(r,t.LINK_STATUS)?r:(t.deleteProgram(r),null)):null}function U(){const t=document.querySelector(".hero-aurora"),s=t?.querySelector(".hero-aurora-field");if(!t||!s)return null;const n=t,r=document.createElement("canvas");r.className="hero-aurora-canvas",r.setAttribute("aria-hidden","true"),n.appendChild(r);const i=document.createElement("div");i.className="hero-aurora-fallback",i.setAttribute("aria-hidden","true"),n.appendChild(i);let e=null,o=null,a=null,u=null,c=!1;try{e=r.getContext("webgl",{alpha:!0,premultipliedAlpha:!1,antialias:!1}),e||(e=r.getContext("experimental-webgl",{alpha:!0,premultipliedAlpha:!1,antialias:!1}))}catch{e=null}if(e)if(o=V(e),o){const d=new Float32Array([-1,-1,1,-1,-1,1,1,1]),g=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,g),e.bufferData(e.ARRAY_BUFFER,d,e.STATIC_DRAW);const p=e.getAttribLocation(o,"aPos");e.enableVertexAttribArray(p),e.vertexAttribPointer(p,2,e.FLOAT,!1,0,0),e.useProgram(o),a=e.getUniformLocation(o,"uResolution"),u=e.getUniformLocation(o,"uTime"),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),e.clearColor(0,0,0,0)}else e=null;r.addEventListener("webglcontextlost",d=>{d.preventDefault(),c=!0,b(),E()},!1);const f=()=>!!(e&&o&&!c);function m(){return window.matchMedia("(prefers-reduced-motion: reduce)").matches}let l=Math.min(window.devicePixelRatio||1,q);function h(){if(!e)return;const d=n.getBoundingClientRect(),g=Math.max(1,Math.round(d.width*l)),p=Math.max(1,Math.round(d.height*l));(r.width!==g||r.height!==p)&&(r.width=g,r.height=p,e.viewport(0,0,g,p))}function w(d){!e||!a||!u||(e.uniform2f(a,r.width,r.height),e.uniform1f(u,d),e.clear(e.COLOR_BUFFER_BIT),e.drawArrays(e.TRIANGLE_STRIP,0,4))}let y=null,A=0,_=0;function S(d){y=requestAnimationFrame(S),!(d-A<D)&&(A=d,_===0&&(_=d),w((d-_)/1e3))}function M(){y===null&&(h(),A=0,y=requestAnimationFrame(S))}function b(){y!==null&&cancelAnimationFrame(y),y=null}let R=!1,P=!0,I=document.visibilityState==="visible";function E(){if(!R){b(),n.classList.remove("is-realistic","is-fallback");return}f()?(n.classList.add("is-realistic"),n.classList.remove("is-fallback"),h(),m()?(b(),w(0)):P&&I?M():b()):(b(),n.classList.add("is-fallback"),n.classList.remove("is-realistic"))}const T=document.getElementById("top");return T&&typeof IntersectionObserver<"u"&&new IntersectionObserver(g=>{for(const p of g)P=p.isIntersecting;E()},{threshold:0}).observe(T),document.addEventListener("visibilitychange",()=>{I=document.visibilityState==="visible",E()}),typeof ResizeObserver<"u"?new ResizeObserver(()=>{h()}).observe(n):window.addEventListener("resize",h),window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change",E),{setLight(d){R=d,E()}}}const x="couplet-site:theme",H="brew tap malinborn/mdmini && brew trust malinborn/mdmini && brew install --cask mdmini";function L(){let t=null;try{t=localStorage.getItem(x)}catch{}return t==="dark"||t==="light"?t:"auto"}function $(){return!window.matchMedia("(prefers-color-scheme: light)").matches}function z(t){return t==="auto"?"dark":t==="dark"?"light":"auto"}function W(){v(()=>import("./mermaid-9kxwM34A.js").then(t=>t.X),[]).then(t=>t.reinitializeTheme()).catch(()=>{})}function X(){const t=document.getElementById("theme-toggle"),s=t?.querySelector(".theme-toggle-label");if(!t||!s)return;const n=U();function r(e){const o=e==="auto"?$():e==="dark";document.documentElement.setAttribute("data-theme",o?"aurora-dark":"aurora-light");const a=e==="auto"?"Auto":e==="dark"?"Dark":"Light";s.textContent=a,t.setAttribute("aria-label",`Theme: ${a.toLowerCase()} (click to change)`),W(),n?.setLight(!o)}t.addEventListener("click",()=>{const e=z(L());try{e==="auto"?localStorage.removeItem(x):localStorage.setItem(x,e)}catch{}r(e)}),window.matchMedia("(prefers-color-scheme: light)").addEventListener("change",()=>{L()==="auto"&&r("auto")}),r(L())}function G(){const t=document.getElementById("copy-install"),s=t?.querySelector(".copy-btn-label");if(!t||!s)return;let n;t.addEventListener("click",()=>{navigator.clipboard.writeText(H).then(()=>{s.textContent="Copied",clearTimeout(n),n=setTimeout(()=>{s.textContent="Copy"},1600)}).catch(()=>{})})}function j(){const t=document.getElementById("ai-carousel"),s=document.getElementById("carousel-track"),n=document.getElementById("track-inner"),r=document.getElementById("carousel-prev"),i=document.getElementById("carousel-next"),e=document.getElementById("carousel-dots");if(!t||!s||!n||!r||!i||!e)return;const o=Array.from(n.querySelectorAll(".slide")),a=Array.from(e.querySelectorAll(".carousel-dot")),u=o.length;if(u===0)return;let c=0;function f(){n.style.transform=`translateX(-${c*100}%)`,a.forEach((l,h)=>l.classList.toggle("is-active",h===c)),o.forEach((l,h)=>{h===c?l.removeAttribute("inert"):l.setAttribute("inert","")})}function m(l){c=(l%u+u)%u,f()}r.addEventListener("click",()=>m(c-1)),i.addEventListener("click",()=>m(c+1)),a.forEach((l,h)=>l.addEventListener("click",()=>m(h))),t.tabIndex=0,t.addEventListener("keydown",l=>{if(l.key==="ArrowLeft")m(c-1);else if(l.key==="ArrowRight")m(c+1);else return;l.preventDefault()}),s.classList.add("js-enabled"),s.scrollLeft=0,f()}async function K(t){switch(t){case"point":return v(()=>import("./point-C0hTxFMh.js"),__vite__mapDeps([0,1,2,3]));case"edit":return v(()=>import("./edit-BfP_11Hi.js"),__vite__mapDeps([4,1,5,2,3]));case"ask":return v(()=>import("./ask-D8yszt1I.js"),__vite__mapDeps([6,1,5,2,3]));case"comment":return v(()=>import("./comment-vqI3HZjZ.js"),__vite__mapDeps([7,2,1,3]));case"anyway":return v(()=>import("./anyway-CZxAY9x-.js"),__vite__mapDeps([8,2,1,3]));case"showcase":return v(()=>import("./showcase-B1lTjOpA.js"),__vite__mapDeps([9,1,2,3]))}}function Y(t){return t==="point"||t==="edit"||t==="ask"||t==="comment"||t==="anyway"||t==="showcase"}function J(){const t=new WeakSet;function s(o){if(t.has(o))return;t.add(o);const a=o.dataset.demoHeight;a&&o.style.setProperty("--demo-h",`${a}px`);const u=o.dataset.demo,c=o.querySelector(".demo-body")??o;Y(u)&&K(u).then(f=>{c.querySelectorAll(":scope > :not(noscript)").forEach(m=>m.remove()),f.mount(c)}).catch(f=>{console.error(`[couplet] demo "${u}" failed to mount`,f)})}const n=Array.from(document.querySelectorAll("[data-demo]"));if(n.length===0)return;const r=new IntersectionObserver(o=>{for(const a of o){if(!a.isIntersecting)continue;const u=a.target;s(u),r.unobserve(u)}},{rootMargin:"200px"});for(const o of n)r.observe(o);const i=document.getElementById("ai"),e=n.find(o=>o.dataset.demo==="showcase");if(i&&e){const o=new IntersectionObserver(a=>{for(const u of a)u.isIntersecting&&(s(e),o.disconnect())},{rootMargin:"600px"});o.observe(i)}}X();G();j();J();export{v as _};
