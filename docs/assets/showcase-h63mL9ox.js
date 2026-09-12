import{V as W,D as h,R as $,c as B,W as q,r as S,b as Z}from"./mermaid-DvKTYutk.js";import{p as J,m as x,H as D,J as Q,K as _,M as U,O as X,P as j,Q as ee,R as te,S as ne,T as oe}from"./editor-demo-BYh0J5pl.js";import"./index-DHJ6rmrw.js";const se=["sk-","pk-","ghp_","ghs_","eyJ","xox","AKIA","token-","secret-"],ie=[/^https?:\/\//i,/^localhost$/i,/^true$/i,/^false$/i,/^\d+$/],re=[/password/i,/secret/i,/token/i,/key$/i,/api_key/i,/apikey/i,/auth/i,/credential/i,/private/i];function H(e,t){if(!e)return!1;if(t){for(const o of re)if(o.test(t))return!0}for(const o of se)if(e.startsWith(o))return!0;if(e.length>20&&/[A-Za-z]/.test(e)&&/[0-9]/.test(e)){for(const o of ie)if(o.test(e))return!1;return!0}return!1}function F(e){return e.length<20||e.length-6<14?"••••••":e.slice(0,3)+"…"+e.slice(-3)}function O(e){return e.startsWith('"')&&e.endsWith('"')||e.startsWith("'")&&e.endsWith("'")?e.slice(1,-1):e}class ae extends q{constructor(t,o,n,s){super(),this.key=t,this.rawValue=o,this.lineFrom=n,this.lineTo=s}eq(t){return this.key===t.key&&this.rawValue===t.rawValue&&this.lineFrom===t.lineFrom&&this.lineTo===t.lineTo}toDOM(){const t=O(this.rawValue),o=!t,n=!o&&H(t,this.key),s=o?"EMPTY":n?F(t):t,i=document.createElement("span");i.className="cm-env-line";const a=document.createElement("span");a.className="cm-env-key",a.textContent=this.key;const l=document.createElement("span");l.className="cm-env-eq",l.textContent="=";const d=o?"cm-env-value cm-env-value-empty":n?"cm-env-value cm-env-value-masked":"cm-env-value",r=document.createElement("span");r.className=d,r.textContent=s;const u=document.createElement("button");return u.className="cm-env-copy",u.textContent="Copy",u.addEventListener("mousedown",p=>{p.preventDefault(),p.stopPropagation(),navigator.clipboard.writeText(t).then(()=>{u.textContent="Copied!",setTimeout(()=>{u.textContent="Copy"},1500)}).catch(()=>{})}),i.appendChild(a),i.appendChild(l),i.appendChild(r),i.appendChild(u),i}ignoreEvent(){return!1}}const ce=/^(\s*)(#.*)$/,le=/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;function L(e){const t=new $,{doc:o}=e.state;for(let n=1;n<=o.lines;n++){const s=o.line(n),i=s.text;if(!i.trim())continue;if(ce.test(i)){t.add(s.from,s.from,h.line({class:"cm-env-comment"}));continue}const a=le.exec(i);if(a){if(B(e,s.from,s.to))continue;const l=a[2],d=a[3],r=new ae(l,d,s.from,s.to);t.add(s.from,s.to,h.replace({widget:r}))}}return t.finish()}const de=W.fromClass(class{decorations;constructor(e){try{this.decorations=L(e)}catch(t){console.warn("Env preview decoration error:",t),this.decorations=h.none}}update(e){if(e.docChanged||e.viewportChanged||e.selectionSet)try{this.decorations=L(e.view)}catch(t){console.warn("Env preview decoration error:",t),this.decorations=h.none}}},{decorations:e=>e.decorations}),ue=/^(\s*)(?:(?:export|declare|typeset|local|readonly)\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;function me(e){const t=ue.exec(e);if(!t)return null;const o=t[2],n=t[3],s=e.length-n.length;if(!n)return null;let i;const a=n[0];if(a==='"'){let r=1;for(;r<n.length;){if(n[r]==="\\"){r+=2;continue}if(n[r]==='"'){r+=1;break}r++}i=r}else if(a==="'"){const r=n.indexOf("'",1);i=r===-1?n.length:r+1}else{let r=0;for(;r<n.length&&n[r]!==" "&&n[r]!=="	"&&n[r]!=="#";)r++;i=r}const l=n.slice(0,i);if(!l)return null;const d=O(l);return!d||d.startsWith("$")||d.startsWith("`")||!H(d,o)?null:{key:o,rawValue:l,valueFrom:s,valueTo:s+i}}class fe extends q{constructor(t,o,n,s){super(),this.key=t,this.rawValue=o,this.from=n,this.to=s}eq(t){return this.key===t.key&&this.rawValue===t.rawValue&&this.from===t.from&&this.to===t.to}toDOM(){const t=O(this.rawValue),o=F(t),n=document.createElement("span");n.className="cm-shell-secret",n.textContent=o;const s=document.createElement("button");s.className="cm-shell-secret-copy",s.textContent="Copy",s.addEventListener("mousedown",a=>{a.preventDefault(),a.stopPropagation(),navigator.clipboard.writeText(t).then(()=>{s.textContent="Copied!",setTimeout(()=>{s.textContent="Copy"},1500)}).catch(()=>{})});const i=document.createElement("span");return i.className="cm-shell-secret-wrapper",i.appendChild(n),i.appendChild(s),i}ignoreEvent(){return!1}}function I(e){const t=new $,{doc:o}=e.state;for(let n=1;n<=o.lines;n++){const s=o.line(n);if(B(e,s.from,s.to))continue;const i=me(s.text);if(!i)continue;const a=s.from+i.valueFrom,l=s.from+i.valueTo;t.add(a,l,h.replace({widget:new fe(i.key,i.rawValue,a,l)}))}return t.finish()}const he=W.fromClass(class{decorations;constructor(e){try{this.decorations=I(e)}catch(t){console.warn("Shell secret decoration error:",t),this.decorations=h.none}}update(e){if(e.docChanged||e.viewportChanged||e.selectionSet)try{this.decorations=I(e.view)}catch(t){console.warn("Shell secret decoration error:",t),this.decorations=h.none}}},{decorations:e=>e.decorations}),k=`flowchart LR
  A[Draft] --> B[Review]
  B --> C[Ship]
  C --> D[Watch]
  D --> E[Done]`,E={filename:"README.md",kind:"markdown",mermaid:k,body:`# Deploy runway

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
${k}
\`\`\`

---

## While you wait

Drop this file on the Dock icon and it opens in its own window, same for a folder full of them. Quit and relaunch and every window comes back where you left it, caret included. Edit it from another terminal and mdmini notices, reloading without asking — nothing here was saved on purpose, it already was. Dark got old an hour ago; one keypress and it's light again.

---`},P={filename:".env",kind:"env",body:`# mdmini — local dev

NODE_ENV=development
PORT=4173
DATABASE_URL=postgres://localhost:5432/mdmini

# third-party
STRIPE_SECRET_KEY=example-value-not-a-real-key
GITHUB_TOKEN=example-value-not-a-real-token
OPENAI_API_KEY=example-value-not-a-real-key
JWT_SECRET=example-value-not-a-real-secret

# flags
ENABLE_ANALYTICS=false
LOG_LEVEL=info`},pe={filename:".zshrc",kind:"shell",body:`# ~/.zshrc

export PATH="$HOME/bin:$PATH"
export EDITOR="mdmini"

export OPENAI_API_KEY="example-value-not-a-real-key"

alias gs="git status"
alias ll="ls -lah"
alias md="mdmini"

function mkcd() {
  mkdir -p "$1" && cd "$1"
}

if [[ -f ~/.zshrc.local ]]; then
  source ~/.zshrc.local
fi`},v=[E,P,pe],z=26,ge=700,ve=6;function C(e){const t=`${e}

${e}`;return t.endsWith(`

`)?t:`${t}

`}function b(e,t,o){if(t.kind==="markdown"){e.dispatch({effects:[D.reconfigure(Q({base:te,codeLanguages:ee,extensions:[ne,oe]})),_.reconfigure(U)]}),o();return}if(t.kind==="env"){e.dispatch({effects:[D.reconfigure([]),_.reconfigure(de)]}),o();return}const n=X(t.filename,t.filename.replace(/^\./,""));if(!n){o();return}n.load().then(s=>{e.dispatch({effects:[D.reconfigure(s),_.reconfigure(j(t.filename)?he:[])]}),o()})}function Ee(e){return e.closest(".demo")?.querySelector(".demo-name")??null}function M(e,t){e&&(e.textContent=`${t} — md-mini`)}function V(e,t){e.scrollPos+=z*t;const o=e.view.scrollDOM.scrollHeight/2;o>0&&e.scrollPos>=o&&(e.scrollPos-=o),e.view.scrollDOM.scrollTop=e.scrollPos}function we(e){const t=e.view.scrollDOM.scrollHeight/2;return Math.max(ve,t/z)}function Ae(e){if(J()){const{view:c}=x(e,{doc:C(E.body)});S(c,k);return}const t=document.createElement("div");t.className="showcase-stage",e.appendChild(t);const o=document.createElement("div");o.className="showcase-lane is-active";const n=document.createElement("div");n.className="showcase-lane",t.appendChild(o),t.appendChild(n);const s=Ee(e);M(s,E.filename);const{view:i}=x(o,{doc:C(E.body)}),{view:a}=x(n,{doc:C(P.body)}),l={el:o,view:i,scrollPos:i.scrollDOM.scrollTop,actIndex:0,ready:!1},d={el:n,view:a,scrollPos:a.scrollDOM.scrollTop,actIndex:1,ready:!1};b(i,E,()=>{l.ready=!0}),b(a,P,()=>{d.ready=!0}),S(i,k);let r=!0,u=!1,p=0,w=0,T=2%v.length,A=!1,N=!0;e.addEventListener("pointerenter",()=>{A=!0}),e.addEventListener("pointerleave",()=>{A=!1}),new IntersectionObserver(c=>{for(const m of c)N=m.isIntersecting},{threshold:0}).observe(e);function K(c,m,f){const y=C(m.body);c.view.dispatch({changes:{from:0,to:c.view.state.doc.length,insert:y},selection:{anchor:y.length},annotations:Z.addToHistory.of(!1)}),c.scrollPos=0,c.view.scrollDOM.scrollTop=0,c.actIndex=f,c.ready=!1,b(c.view,m,()=>{c.ready=!0}),m.mermaid&&S(c.view,m.mermaid)}function G(){u=!0;const c=r?d:l,m=r?l:d;c.el.classList.add("is-active"),m.el.classList.remove("is-active"),M(s,v[c.actIndex].filename),window.setTimeout(()=>{r=!r,u=!1,p=0,w=0;const f=v[T];T=(T+1)%v.length,K(m,f,v.indexOf(f))},ge)}let g=null;function R(c){if(requestAnimationFrame(R),!(N&&!A&&!document.hidden)){g=null;return}if(g===null){g=c;return}const f=(c-g)/1e3;if(g=c,V(l,f),V(d,f),u)return;const y=r?l:d,Y=r?d:l;w=Math.max(w,we(y)),p+=f,p>=w&&Y.ready&&G()}requestAnimationFrame(R)}export{Ae as mount};
