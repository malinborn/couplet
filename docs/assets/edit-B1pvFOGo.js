import{C as y,T as D}from"./mermaid-BU_h6rrN.js";import{c as h}from"./content-diff-ZzYjSwqm.js";import{m as I,p as U,s as L,c as q}from"./editor-demo-uddX9BUi.js";import"./index-BBSfBBRN.js";const p=`# Rollback runbook
## Rollback procedure
Rollbacks re-deploy the previous tag. The registry keeps the last five
artifacts pinned for exactly this reason.

## Database changes
Some schema changes might undo automatically during a rollback — double-check
the migration state before assuming anything.

## Escalation

Page the on-call engineer if the rollback itself fails.

`,E=`# Rollback runbook
## Rollback procedure
Rollbacks re-deploy the previous tag. The registry keeps the last five
artifacts pinned for exactly this reason.

## Database changes
Database migrations are reverted only by an explicit down-migration — never
automatically.

## Escalation

Page the on-call engineer if the rollback itself fails.

`,S='claude "tighten rollback wording in runbook.md"',V="cat new.md | mdmini edit runbook.md --show",$="agent — zsh",H=32,Y=22,j=350,z=250,G=700,W=550,X=2600,B=900;function F(t){t.classList.add("demo-terminal"),t.innerHTML=`
    <div class="demo-bar">
      <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
      <span class="demo-name">${$}</span>
    </div>
    <div class="demo-terminal-body">
      <div class="demo-terminal-line">
        <span class="demo-terminal-prompt">$</span>
        <span class="demo-terminal-command"></span><span class="demo-terminal-cursor"></span>
      </div>
      <div class="demo-terminal-line demo-terminal-line--tool">
        <span class="demo-terminal-tag">agent</span>
        <span class="demo-terminal-arrow">&rarr;</span>
        <span class="demo-terminal-tool"></span>
      </div>
      <div class="demo-terminal-line demo-terminal-line--status">
        <span class="demo-terminal-status"></span>
      </div>
    </div>
  `;const n=t.querySelector(".demo-terminal-command"),o=t.querySelector(".demo-terminal-cursor"),l=t.querySelector(".demo-terminal-line--tool"),s=t.querySelector(".demo-terminal-tool"),i=t.querySelector(".demo-terminal-line--status"),c=t.querySelector(".demo-terminal-status");if(!n||!o||!l||!s||!i||!c)throw new Error("demo-terminal: expected markup missing");return{commandEl:n,cursorEl:o,toolLineEl:l,toolCmdEl:s,statusLineEl:i,statusEl:c}}function J(t){t.commandEl.textContent="",t.toolCmdEl.textContent="",t.statusEl.textContent="",t.cursorEl.classList.remove("is-blinking"),t.toolLineEl.classList.remove("is-visible"),t.statusLineEl.classList.remove("is-visible"),t.statusEl.classList.remove("demo-terminal-status--running","demo-terminal-status--ok")}function k(t){t.toolCmdEl.textContent=V,t.toolLineEl.classList.add("is-visible"),t.statusLineEl.classList.add("is-visible"),t.statusEl.textContent="running…",t.statusEl.classList.remove("demo-terminal-status--ok"),t.statusEl.classList.add("demo-terminal-status--running")}function K(t,n){const o=D.of(n.split(`
`)),l=o.lineAt(t.from).number,s=t.from+t.insert.length,i=o.lineAt(Math.max(t.from,s-1)).number;return[l,i]}function T(t,n){const o=n?`[[${K(n,E).join(", ")}]]`:"[]";t.statusEl.textContent=`{"ok": true, "changed_lines": ${o}}`,t.statusEl.classList.remove("demo-terminal-status--running"),t.statusEl.classList.add("demo-terminal-status--ok")}function R(t,n){const o=new MutationObserver(()=>{t.isConnected||(o.disconnect(),n())});o.observe(document.body,{childList:!0,subtree:!0})}function st(t){const{view:n,destroy:o}=I(t,{doc:p}),l=t.closest(".slide")?.querySelector('[data-demo-chrome="edit"]')??null,s=l?F(l):null;if(U()){const e=h(p,E);e&&n.dispatch({changes:y.of(e,n.state.doc.length),effects:[L.of([{from:e.from,to:e.from+e.insert.length}])]}),s&&(s.commandEl.textContent=S,k(s),T(s,e)),R(t,o);return}let i=!0,c=!0,d=[];function C(){return c&&!document.hidden}function m(){const e=d;d=[],e.forEach(a=>a())}function _(){return!i||C()?Promise.resolve():new Promise(e=>d.push(e))}const b=new IntersectionObserver(e=>{for(const a of e)c=a.isIntersecting;m()},{threshold:0});b.observe(t);function v(){m()}document.addEventListener("visibilitychange",v);function x(e){return new Promise(a=>window.setTimeout(a,e))}async function r(e){return await _(),i?(await x(e),i):!1}async function M(e,a,f){e.textContent="";for(const u of a)if(e.textContent+=u,!await r(f))return!1;return!0}async function A(e){if(!e)return!0;const{from:a,to:f,insert:u}=e;n.dispatch({changes:{from:a,to:f,insert:""}});let g=a;for(const w of u)if(n.dispatch({changes:{from:g,to:g,insert:w}}),g+=w.length,!await r(Y))return!1;return n.dispatch({effects:L.of([{from:a,to:a+u.length}])}),!0}function P(){const e=h(n.state.doc.toString(),p);e&&n.dispatch({changes:y.of(e,n.state.doc.length),effects:[q.of(null)]}),s&&J(s)}async function O(){if(s&&s.cursorEl.classList.add("is-blinking"),s&&!await M(s.commandEl,S,H)||!await r(j)||(s&&s.cursorEl.classList.remove("is-blinking"),!await r(z))||(s&&k(s),!await r(G)))return!1;const e=h(n.state.doc.toString(),E);return s&&T(s,e),!await r(W)||!await A(e)||!await r(X)?!1:(P(),r(B))}async function N(){for(;i;)if(!await O())return}N(),R(t,()=>{i=!1,b.disconnect(),document.removeEventListener("visibilitychange",v),m(),o()})}export{st as mount};
