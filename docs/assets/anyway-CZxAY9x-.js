import{p as D}from"./editor-demo-DAnqNgJ4.js";import"./mermaid-9kxwM34A.js";import"./index-B5i03YgG.js";const r=["README.md","CLAUDE.md","auth_spec.md"],A=`couplet ${r.join(" ")}`,T=380,h=400,C=430,m=.55,$=1.3,q=320,H=42,I=350,R=700,G=1300,N=450,O=320,U=450,x=420,P=160,F=450,k=1100,W=260,j=280,K=460,z=500,V=320,Y=320,Q=480,X=180,B=420,J=1300,Z=550,aa=`
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
            <span class="anyway-wintitle">${a} — couplet</span>
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
            <span class="anyway-wintitle">Untitled — couplet</span>
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
`;function sa(a){const s=l=>a.querySelector(`[data-el="${l}"]`),n=s("label"),i=s("wrap"),e=s("stage"),t=s("terminal"),c=s("typed"),y=s("caret"),w=s("winSolo"),f=s("dock"),v=s("dockicon"),S=s("marquee"),_=s("stack"),L=s("cursor"),g=r.map((l,o)=>s(`win${o}`)),E=r.map((l,o)=>s(`file${o}`));return!n||!i||!e||!t||!c||!y||!w||!f||!v||!S||!_||!L||g.some(l=>!l)||E.some(l=>!l)?null:{label:n,wrap:i,stage:e,terminal:t,typed:c,caret:y,windows:g,winSolo:w,dock:f,dockicon:v,files:E,marquee:S,stack:_,cursor:L}}const na=["is-visible","is-open","is-dropped","is-pressed","is-clicking","is-at-dock","is-blinking","is-marquee","is-armed","is-dragging","is-releasing","is-selected","is-lifted","is-gone","is-carried"];function ea(a){for(const s of na)a.querySelectorAll(`.${s}`).forEach(n=>n.classList.remove(s))}function b(a){const s=a.wrap.clientWidth;if(s<=0)return;const n=s/T,i=C/h,e=Math.max(m,Math.min($,n,i));a.stage.style.transform=`scale(${e})`,a.wrap.style.height=`${Math.round(h*e)}px`}class ia{_cancelled=!1;onScreen=!0;hidden=document.hidden;get cancelled(){return this._cancelled}get running(){return!this._cancelled&&this.onScreen&&!this.hidden}cancel(){this._cancelled=!0}setOnScreen(s){this.onScreen=s}setHidden(s){this.hidden=s}wait(s){return new Promise(n=>{if(this._cancelled){n();return}let i=s,e=null;const t=c=>{if(this._cancelled){n();return}if(this.running?(e!==null&&(i-=c-e),e=c):e=null,i<=0){n();return}requestAnimationFrame(t)};requestAnimationFrame(t)})}}async function ta(a,s,n,i){for(let e=1;e<=n.length;e++)if(s.textContent=n.slice(0,e),await a.wait(i),a.cancelled)return}function d(a,s){a.label.textContent=s}function p(a){for(const s of a)s.classList.add("is-open")}async function u(a,s){ea(s.stage),await a.wait(N)}async function ca(a,s){d(s,"from the terminal"),s.terminal.classList.add("is-visible"),await a.wait(q),!a.cancelled&&(s.caret.classList.add("is-blinking"),await ta(a,s.typed,A,H),!a.cancelled&&(await a.wait(I),!a.cancelled&&(p(s.windows),await a.wait(R+G),!a.cancelled&&await u(a,s))))}async function la(a,s){d(s,"as an app"),s.dock.classList.add("is-visible"),await a.wait(O),!a.cancelled&&(s.cursor.classList.add("is-visible"),await a.wait(U),!a.cancelled&&(s.cursor.classList.add("is-at-dock"),await a.wait(x),!a.cancelled&&(s.cursor.classList.add("is-clicking"),s.dockicon.classList.add("is-pressed"),await a.wait(P),!a.cancelled&&(s.dockicon.classList.remove("is-pressed"),s.winSolo.classList.add("is-open"),await a.wait(F+k),!a.cancelled&&await u(a,s)))))}async function ra(a,s){d(s,"dock drop"),s.dock.classList.add("is-visible");for(const n of s.files)n.classList.add("is-visible");if(await a.wait(O+W),!a.cancelled&&(s.cursor.classList.add("is-marquee","is-visible"),await a.wait(j),!a.cancelled&&(s.cursor.classList.add("is-armed"),await a.wait(K),!a.cancelled&&(s.cursor.classList.add("is-clicking"),await a.wait(P),!a.cancelled)))){s.marquee.classList.add("is-dragging"),s.cursor.classList.add("is-dragging");for(const n of s.files)n.classList.add("is-selected");if(await a.wait(z),!a.cancelled&&(await a.wait(V),!a.cancelled)){s.marquee.classList.add("is-releasing"),s.stack.classList.add("is-visible");for(const n of s.files)n.classList.add("is-lifted");if(await a.wait(Y),!a.cancelled&&(s.cursor.classList.add("is-carried"),s.stack.classList.add("is-carried"),await a.wait(Q),!a.cancelled)){s.dockicon.classList.add("is-pressed"),s.stack.classList.add("is-dropped");for(const n of s.files)n.classList.add("is-gone");await a.wait(X),!a.cancelled&&(s.dockicon.classList.remove("is-pressed"),await a.wait(B),!a.cancelled&&(p(s.windows),await a.wait(R+J),!a.cancelled&&await u(a,s)))}}}}async function da(a,s){for(;!a.cancelled;){if(await ca(a,s),a.cancelled||(await la(a,s),a.cancelled)||(await ra(a,s),a.cancelled))return;d(s,""),await a.wait(Z)}}function ya(a){a.terminal.closest(".anyway-root")?.classList.add("is-static"),d(a,""),a.terminal.classList.add("is-visible"),a.typed.textContent=A,p(a.windows),a.dock.classList.add("is-visible");for(const s of a.files)s.classList.add("is-visible")}function M(a,s){const n=new MutationObserver(()=>{a.isConnected||(n.disconnect(),s())});n.observe(document.body,{childList:!0,subtree:!0})}function ua(a){a.innerHTML=`<div class="anyway-root" aria-hidden="true">${aa}</div>`;const s=a.querySelector(".anyway-root"),n=s&&sa(s);if(!s||!n)return;b(n);const i=new ResizeObserver(()=>b(n));if(i.observe(n.wrap),D()){ya(n),M(a,()=>i.disconnect());return}const e=new ia,t=new IntersectionObserver(y=>{for(const w of y)e.setOnScreen(w.isIntersecting)},{threshold:0});t.observe(a);const c=()=>e.setHidden(document.hidden);document.addEventListener("visibilitychange",c),da(e,n),M(a,()=>{e.cancel(),t.disconnect(),i.disconnect(),document.removeEventListener("visibilitychange",c)})}export{ua as mount};
