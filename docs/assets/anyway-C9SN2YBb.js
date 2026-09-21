import{p as P}from"./editor-demo-uddX9BUi.js";import"./mermaid-BU_h6rrN.js";import"./index-BBSfBBRN.js";const r=["README.md","CLAUDE.md","auth_spec.md"],A=`mdmini ${r.join(" ")}`,D=380,h=400,T=430,C=.55,$=1.3,q=320,H=42,I=350,R=700,G=1300,N=450,O=320,U=450,x=420,m=160,F=450,k=1100,W=260,j=280,K=460,z=500,V=320,Y=320,Q=480,X=180,B=420,J=1300,Z=550,aa=`
  <div class="anyway-label" data-el="label"></div>
  <div class="anyway-frame">
    <div class="anyway-stage-wrap" data-el="wrap">
      <div class="anyway-stage" data-el="stage">
        <div class="anyway-terminal" data-el="terminal">
          <div class="anyway-winbar">
            <span class="anyway-dot anyway-dot--red"></span>
            <span class="anyway-dot anyway-dot--yellow"></span>
            <span class="anyway-dot anyway-dot--green"></span>
            <span class="anyway-wintitle">zsh</span>
          </div>
          <div class="anyway-termbody">
            <span class="anyway-prompt">$</span>
            <span data-el="typed"></span><span class="anyway-caret" data-el="caret"></span>
          </div>
        </div>

        ${r.map((a,s)=>`
        <div class="anyway-win anyway-win--${s}" data-el="win${s}">
          <div class="anyway-winbar">
            <span class="anyway-dot anyway-dot--red"></span>
            <span class="anyway-dot anyway-dot--yellow"></span>
            <span class="anyway-dot anyway-dot--green"></span>
            <span class="anyway-wintitle">${a} — md-mini</span>
          </div>
          <div class="anyway-winbody">
            <span class="anyway-skel anyway-skel--head"></span>
            <span class="anyway-skel"></span>
            <span class="anyway-skel anyway-skel--sm"></span>
            <span class="anyway-skel anyway-skel--md"></span>
          </div>
        </div>`).join("")}

        <div class="anyway-win anyway-win--solo" data-el="winSolo">
          <div class="anyway-winbar">
            <span class="anyway-dot anyway-dot--red"></span>
            <span class="anyway-dot anyway-dot--yellow"></span>
            <span class="anyway-dot anyway-dot--green"></span>
            <span class="anyway-wintitle">Untitled — md-mini</span>
          </div>
          <div class="anyway-winbody">
            <span class="anyway-skel anyway-skel--head"></span>
            <span class="anyway-skel"></span>
            <span class="anyway-skel anyway-skel--sm"></span>
          </div>
        </div>

        <div class="anyway-dock" data-el="dock">
          <div class="anyway-dockicon" data-el="dockicon">
            <span class="anyway-dockicon-text">md</span>
          </div>
        </div>

        ${r.map((a,s)=>`
        <div class="anyway-file anyway-file--${s}" data-el="file${s}">
          <div class="anyway-file-icon">
            <span class="anyway-file-icon-line anyway-file-icon-line--1"></span>
            <span class="anyway-file-icon-line anyway-file-icon-line--2"></span>
            <span class="anyway-file-icon-line anyway-file-icon-line--3"></span>
          </div>
          <div class="anyway-file-name">${a}</div>
        </div>`).join("")}

        <div class="anyway-marquee" data-el="marquee"></div>

        <div class="anyway-stack" data-el="stack">
          <span class="anyway-stack-card anyway-stack-card--0"></span>
          <span class="anyway-stack-card anyway-stack-card--1"></span>
          <span class="anyway-stack-card anyway-stack-card--2"></span>
          <span class="anyway-stack-badge">${r.length}</span>
        </div>

        <div class="anyway-cursor" data-el="cursor"></div>
      </div>
    </div>
  </div>
`;function sa(a){const s=l=>a.querySelector(`[data-el="${l}"]`),n=s("label"),e=s("wrap"),i=s("stage"),t=s("terminal"),c=s("typed"),y=s("caret"),w=s("winSolo"),u=s("dock"),v=s("dockicon"),S=s("marquee"),_=s("stack"),L=s("cursor"),g=r.map((l,o)=>s(`win${o}`)),E=r.map((l,o)=>s(`file${o}`));return!n||!e||!i||!t||!c||!y||!w||!u||!v||!S||!_||!L||g.some(l=>!l)||E.some(l=>!l)?null:{label:n,wrap:e,stage:i,terminal:t,typed:c,caret:y,windows:g,winSolo:w,dock:u,dockicon:v,files:E,marquee:S,stack:_,cursor:L}}const na=["is-visible","is-open","is-dropped","is-pressed","is-clicking","is-at-dock","is-blinking","is-marquee","is-armed","is-dragging","is-releasing","is-selected","is-lifted","is-gone","is-carried"];function ia(a){for(const s of na)a.querySelectorAll(`.${s}`).forEach(n=>n.classList.remove(s))}function b(a){const s=a.wrap.clientWidth;if(s<=0)return;const n=s/D,e=T/h,i=Math.max(C,Math.min($,n,e));a.stage.style.transform=`scale(${i})`,a.wrap.style.height=`${Math.round(h*i)}px`}class ea{_cancelled=!1;onScreen=!0;hidden=document.hidden;get cancelled(){return this._cancelled}get running(){return!this._cancelled&&this.onScreen&&!this.hidden}cancel(){this._cancelled=!0}setOnScreen(s){this.onScreen=s}setHidden(s){this.hidden=s}wait(s){return new Promise(n=>{if(this._cancelled){n();return}let e=s,i=null;const t=c=>{if(this._cancelled){n();return}if(this.running?(i!==null&&(e-=c-i),i=c):i=null,e<=0){n();return}requestAnimationFrame(t)};requestAnimationFrame(t)})}}async function ta(a,s,n,e){for(let i=1;i<=n.length;i++)if(s.textContent=n.slice(0,i),await a.wait(e),a.cancelled)return}function d(a,s){a.label.textContent=s}function p(a){for(const s of a)s.classList.add("is-open")}async function f(a,s){ia(s.stage),await a.wait(N)}async function ca(a,s){d(s,"from the terminal"),s.terminal.classList.add("is-visible"),await a.wait(q),!a.cancelled&&(s.caret.classList.add("is-blinking"),await ta(a,s.typed,A,H),!a.cancelled&&(await a.wait(I),!a.cancelled&&(p(s.windows),await a.wait(R+G),!a.cancelled&&await f(a,s))))}async function la(a,s){d(s,"as an app"),s.dock.classList.add("is-visible"),await a.wait(O),!a.cancelled&&(s.cursor.classList.add("is-visible"),await a.wait(U),!a.cancelled&&(s.cursor.classList.add("is-at-dock"),await a.wait(x),!a.cancelled&&(s.cursor.classList.add("is-clicking"),s.dockicon.classList.add("is-pressed"),await a.wait(m),!a.cancelled&&(s.dockicon.classList.remove("is-pressed"),s.winSolo.classList.add("is-open"),await a.wait(F+k),!a.cancelled&&await f(a,s)))))}async function ra(a,s){d(s,"dock drop"),s.dock.classList.add("is-visible");for(const n of s.files)n.classList.add("is-visible");if(await a.wait(O+W),!a.cancelled&&(s.cursor.classList.add("is-marquee","is-visible"),await a.wait(j),!a.cancelled&&(s.cursor.classList.add("is-armed"),await a.wait(K),!a.cancelled&&(s.cursor.classList.add("is-clicking"),await a.wait(m),!a.cancelled)))){s.marquee.classList.add("is-dragging"),s.cursor.classList.add("is-dragging");for(const n of s.files)n.classList.add("is-selected");if(await a.wait(z),!a.cancelled&&(await a.wait(V),!a.cancelled)){s.marquee.classList.add("is-releasing"),s.stack.classList.add("is-visible");for(const n of s.files)n.classList.add("is-lifted");if(await a.wait(Y),!a.cancelled&&(s.cursor.classList.add("is-carried"),s.stack.classList.add("is-carried"),await a.wait(Q),!a.cancelled)){s.dockicon.classList.add("is-pressed"),s.stack.classList.add("is-dropped");for(const n of s.files)n.classList.add("is-gone");await a.wait(X),!a.cancelled&&(s.dockicon.classList.remove("is-pressed"),await a.wait(B),!a.cancelled&&(p(s.windows),await a.wait(R+J),!a.cancelled&&await f(a,s)))}}}}async function da(a,s){for(;!a.cancelled;){if(await ca(a,s),a.cancelled||(await la(a,s),a.cancelled)||(await ra(a,s),a.cancelled))return;d(s,""),await a.wait(Z)}}function ya(a){a.terminal.closest(".anyway-root")?.classList.add("is-static"),d(a,""),a.terminal.classList.add("is-visible"),a.typed.textContent=A,p(a.windows),a.dock.classList.add("is-visible");for(const s of a.files)s.classList.add("is-visible")}function M(a,s){const n=new MutationObserver(()=>{a.isConnected||(n.disconnect(),s())});n.observe(document.body,{childList:!0,subtree:!0})}function fa(a){a.innerHTML=`<div class="anyway-root" aria-hidden="true">${aa}</div>`;const s=a.querySelector(".anyway-root"),n=s&&sa(s);if(!s||!n)return;b(n);const e=new ResizeObserver(()=>b(n));if(e.observe(n.wrap),P()){ya(n),M(a,()=>e.disconnect());return}const i=new ea,t=new IntersectionObserver(y=>{for(const w of y)i.setOnScreen(w.isIntersecting)},{threshold:0});t.observe(a);const c=()=>i.setHidden(document.hidden);document.addEventListener("visibilitychange",c),da(i,n),M(a,()=>{i.cancel(),t.disconnect(),e.disconnect(),document.removeEventListener("visibilitychange",c)})}export{fa as mount};
