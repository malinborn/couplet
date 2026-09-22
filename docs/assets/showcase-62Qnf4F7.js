import{V as $,D as p,R as B,c as q,W as H,t as h,r as x,b as J}from"./mermaid-CvGFl8yv.js";import{p as Q,m as D,H as _,J as U,K as b,M as X,O as j,P as ee,Q as te,R as ne,S as oe,T as se}from"./editor-demo-B6pwY3ae.js";import"./index-MEN6h8EX.js";const ie=["sk-","pk-","ghp_","ghs_","eyJ","xox","AKIA","token-","secret-"],re=[/^https?:\/\//i,/^localhost$/i,/^true$/i,/^false$/i,/^\d+$/],ae=[/password/i,/secret/i,/token/i,/key$/i,/api_key/i,/apikey/i,/auth/i,/credential/i,/private/i];function F(e,t){if(!e)return!1;if(t){for(const o of ae)if(o.test(t))return!0}for(const o of ie)if(e.startsWith(o))return!0;if(e.length>20&&/[A-Za-z]/.test(e)&&/[0-9]/.test(e)){for(const o of re)if(o.test(e))return!1;return!0}return!1}function z(e){return e.length<20||e.length-6<14?"••••••":e.slice(0,3)+"…"+e.slice(-3)}function N(e){return e.startsWith('"')&&e.endsWith('"')||e.startsWith("'")&&e.endsWith("'")?e.slice(1,-1):e}class ce extends H{constructor(t,o,n,s){super(),this.key=t,this.rawValue=o,this.lineFrom=n,this.lineTo=s}eq(t){return this.key===t.key&&this.rawValue===t.rawValue&&this.lineFrom===t.lineFrom&&this.lineTo===t.lineTo}toDOM(){const t=N(this.rawValue),o=!t,n=!o&&F(t,this.key),s=o?h("editor.env.empty_value"):n?z(t):t,i=document.createElement("span");i.className="cm-env-line";const a=document.createElement("span");a.className="cm-env-key",a.textContent=this.key;const l=document.createElement("span");l.className="cm-env-eq",l.textContent="=";const d=o?"cm-env-value cm-env-value-empty":n?"cm-env-value cm-env-value-masked":"cm-env-value",r=document.createElement("span");r.className=d,r.textContent=s;const u=document.createElement("button");return u.className="cm-env-copy",u.textContent=h("ui.copy"),u.addEventListener("mousedown",v=>{v.preventDefault(),v.stopPropagation(),navigator.clipboard.writeText(t).then(()=>{u.textContent=h("ui.copied"),setTimeout(()=>{u.textContent=h("ui.copy")},1500)}).catch(()=>{})}),i.appendChild(a),i.appendChild(l),i.appendChild(r),i.appendChild(u),i}ignoreEvent(){return!1}}const le=/^(\s*)(#.*)$/,de=/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;function I(e){const t=new B,{doc:o}=e.state;for(let n=1;n<=o.lines;n++){const s=o.line(n),i=s.text;if(!i.trim())continue;if(le.test(i)){t.add(s.from,s.from,p.line({class:"cm-env-comment"}));continue}const a=de.exec(i);if(a){if(q(e,s.from,s.to))continue;const l=a[2],d=a[3],r=new ce(l,d,s.from,s.to);t.add(s.from,s.to,p.replace({widget:r}))}}return t.finish()}const ue=$.fromClass(class{decorations;constructor(e){try{this.decorations=I(e)}catch(t){console.warn("Env preview decoration error:",t),this.decorations=p.none}}update(e){if(e.docChanged||e.viewportChanged||e.selectionSet)try{this.decorations=I(e.view)}catch(t){console.warn("Env preview decoration error:",t),this.decorations=p.none}}},{decorations:e=>e.decorations}),me=/^(\s*)(?:(?:export|declare|typeset|local|readonly)\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;function fe(e){const t=me.exec(e);if(!t)return null;const o=t[2],n=t[3],s=e.length-n.length;if(!n)return null;let i;const a=n[0];if(a==='"'){let r=1;for(;r<n.length;){if(n[r]==="\\"){r+=2;continue}if(n[r]==='"'){r+=1;break}r++}i=r}else if(a==="'"){const r=n.indexOf("'",1);i=r===-1?n.length:r+1}else{let r=0;for(;r<n.length&&n[r]!==" "&&n[r]!=="	"&&n[r]!=="#";)r++;i=r}const l=n.slice(0,i);if(!l)return null;const d=N(l);return!d||d.startsWith("$")||d.startsWith("`")||!F(d,o)?null:{key:o,rawValue:l,valueFrom:s,valueTo:s+i}}class he extends H{constructor(t,o,n,s){super(),this.key=t,this.rawValue=o,this.from=n,this.to=s}eq(t){return this.key===t.key&&this.rawValue===t.rawValue&&this.from===t.from&&this.to===t.to}toDOM(){const t=N(this.rawValue),o=z(t),n=document.createElement("span");n.className="cm-shell-secret",n.textContent=o;const s=document.createElement("button");s.className="cm-shell-secret-copy",s.textContent=h("ui.copy"),s.addEventListener("mousedown",a=>{a.preventDefault(),a.stopPropagation(),navigator.clipboard.writeText(t).then(()=>{s.textContent=h("ui.copied"),setTimeout(()=>{s.textContent=h("ui.copy")},1500)}).catch(()=>{})});const i=document.createElement("span");return i.className="cm-shell-secret-wrapper",i.appendChild(n),i.appendChild(s),i}ignoreEvent(){return!1}}function M(e){const t=new B,{doc:o}=e.state;for(let n=1;n<=o.lines;n++){const s=o.line(n);if(q(e,s.from,s.to))continue;const i=fe(s.text);if(!i)continue;const a=s.from+i.valueFrom,l=s.from+i.valueTo;t.add(a,l,p.replace({widget:new he(i.key,i.rawValue,a,l)}))}return t.finish()}const pe=$.fromClass(class{decorations;constructor(e){try{this.decorations=M(e)}catch(t){console.warn("Shell secret decoration error:",t),this.decorations=p.none}}update(e){if(e.docChanged||e.viewportChanged||e.selectionSet)try{this.decorations=M(e.view)}catch(t){console.warn("Shell secret decoration error:",t),this.decorations=p.none}}},{decorations:e=>e.decorations}),T=`flowchart LR
  A[Draft] --> B[Review]
  B --> C[Ship]
  C --> D[Watch]
  D --> E[Done]`,w={filename:"README.md",kind:"markdown",mermaid:T,body:`# Deploy runway

## Before you ship

Confirm the build is **reproducible** and matches the tag in \`CHANGELOG.md\`. Any heading folds its section away with a click — collapse this one once it's done.
- [x] Bump the version in \`package.json\`
- [ ] Draft the release notes

| Step | Owner | Status |
| --- | --- | --- |
| Build | CI | done |
| Notarize | CI | pending |

\`\`\`bash
npm run build:dev && open dist/md-mini-dev.app
\`\`\`

---

## Once it's out the door

The rollout is *gradual*, never **instant**, and it is ~~definitely not~~ absolutely not something we push on a Friday. Watch the crash rate in \`metrics.dashboard\`, and keep the [release notes](https://github.com/malinborn/mdmini/releases) open in a second window.

1. Announce the build
2. Watch the first hour of crash reports
3. Close the loop once it stays quiet

> If anything looks wrong, roll back first and investigate after.

\`\`\`ts
export function mountDemoEditor(parent: HTMLElement, options: DemoEditorOptions): DemoEditor {
  const view = new EditorView({ state, parent });
  return { view, destroy: () => view.destroy() };
}
\`\`\`

\`\`\`mermaid
${T}
\`\`\`

---

## While you wait

Drop this file on the Dock icon and it opens in its own window, same for a folder full of them. Quit and relaunch and every window comes back where you left it, caret included. Edit it from another terminal and couplet notices, reloading without asking — nothing here was saved on purpose, it already was. Dark got old an hour ago; one keypress and it's light again.

---`},P={filename:".env",kind:"env",body:`# couplet — local dev

NODE_ENV=development
PORT=4173
DATABASE_URL=postgres://localhost:5432/couplet

# third-party
STRIPE_SECRET_KEY=example-value-not-a-real-key
GITHUB_TOKEN=example-value-not-a-real-token
OPENAI_API_KEY=example-value-not-a-real-key
JWT_SECRET=example-value-not-a-real-secret

# flags
ENABLE_ANALYTICS=false
LOG_LEVEL=info`},ve={filename:".zshrc",kind:"shell",body:`# ~/.zshrc

export PATH="$HOME/bin:$PATH"
export EDITOR="couplet"

export OPENAI_API_KEY="example-value-not-a-real-key"

alias gs="git status"
alias ll="ls -lah"
alias md="couplet"

function mkcd() {
  mkdir -p "$1" && cd "$1"
}

if [[ -f ~/.zshrc.local ]]; then
  source ~/.zshrc.local
fi`},E=[w,P,ve],K=26,ge=700,Ee=6;function k(e){const t=`${e}

${e}`;return t.endsWith(`

`)?t:`${t}

`}function O(e,t,o){if(t.kind==="markdown"){e.dispatch({effects:[_.reconfigure(U({base:ne,codeLanguages:te,extensions:[oe,se]})),b.reconfigure(X)]}),o();return}if(t.kind==="env"){e.dispatch({effects:[_.reconfigure([]),b.reconfigure(ue)]}),o();return}const n=j(t.filename,t.filename.replace(/^\./,""));if(!n){o();return}n.load().then(s=>{e.dispatch({effects:[_.reconfigure(s),b.reconfigure(ee(t.filename)?pe:[])]}),o()})}function we(e){return e.closest(".demo")?.querySelector(".demo-name")??null}function V(e,t){e&&(e.textContent=`${t} — couplet`)}function W(e,t){e.scrollPos+=K*t;const o=e.view.scrollDOM.scrollHeight/2;o>0&&e.scrollPos>=o&&(e.scrollPos-=o),e.view.scrollDOM.scrollTop=e.scrollPos}function ye(e){const t=e.view.scrollDOM.scrollHeight/2;return Math.max(Ee,t/K)}function Se(e){if(Q()){const{view:c}=D(e,{doc:k(w.body)});x(c,T);return}const t=document.createElement("div");t.className="showcase-stage",e.appendChild(t);const o=document.createElement("div");o.className="showcase-lane is-active";const n=document.createElement("div");n.className="showcase-lane",t.appendChild(o),t.appendChild(n);const s=we(e);V(s,w.filename);const{view:i}=D(o,{doc:k(w.body)}),{view:a}=D(n,{doc:k(P.body)}),l={el:o,view:i,scrollPos:i.scrollDOM.scrollTop,actIndex:0,ready:!1},d={el:n,view:a,scrollPos:a.scrollDOM.scrollTop,actIndex:1,ready:!1};O(i,w,()=>{l.ready=!0}),O(a,P,()=>{d.ready=!0}),x(i,T);let r=!0,u=!1,v=0,y=0,A=2%E.length,S=!1,R=!0;e.addEventListener("pointerenter",()=>{S=!0}),e.addEventListener("pointerleave",()=>{S=!1}),new IntersectionObserver(c=>{for(const m of c)R=m.isIntersecting},{threshold:0}).observe(e);function G(c,m,f){const C=k(m.body);c.view.dispatch({changes:{from:0,to:c.view.state.doc.length,insert:C},selection:{anchor:C.length},annotations:J.addToHistory.of(!1)}),c.scrollPos=0,c.view.scrollDOM.scrollTop=0,c.actIndex=f,c.ready=!1,O(c.view,m,()=>{c.ready=!0}),m.mermaid&&x(c.view,m.mermaid)}function Y(){u=!0;const c=r?d:l,m=r?l:d;c.el.classList.add("is-active"),m.el.classList.remove("is-active"),V(s,E[c.actIndex].filename),window.setTimeout(()=>{r=!r,u=!1,v=0,y=0;const f=E[A];A=(A+1)%E.length,G(m,f,E.indexOf(f))},ge)}let g=null;function L(c){if(requestAnimationFrame(L),!(R&&!S&&!document.hidden)){g=null;return}if(g===null){g=c;return}const f=(c-g)/1e3;if(g=c,W(l,f),W(d,f),u)return;const C=r?l:d,Z=r?d:l;y=Math.max(y,ye(C)),v+=f,v>=y&&Z.ready&&Y()}requestAnimationFrame(L)}export{Se as mount};
