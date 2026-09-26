import{E as z}from"./mermaid-B609I8Vk.js";import{m as J,p as K,c as y,G as Z}from"./editor-demo-BRYhMLQt.js";import"./index-QPVCzPn2.js";function G(e){return e.includes("\r")?e.replace(/\r\n?/g,`
`):e}function P(e,n){if(n.line!==null){const i=Math.min(Math.max(n.line,1),e.doc.lines);return e.doc.line(i).from}if(n.find!==null){const i=e.doc.toString().indexOf(G(n.find));return i===-1?null:i}return 0}const q="Rollbacks re-deploy the previous tag.",X="Re-deploy the previous tag, nothing else.",ee=`# Rollback runbook

## When to roll back

Roll back when the health check fails twice in a row after a deploy, or when
error rates jump right after a release ships.

## Rollback procedure

${q}

The registry keeps the last five artifacts pinned, so the previous build is
always one command away.

1. Confirm the previous tag is still in the registry.
2. Flip the deployment alias back to that tag.
3. Watch the health check turn green before closing the incident.

## Database changes

Schema changes are never rolled back automatically. If the release included
a migration, check whether it needs an explicit down-migration first.

## Monitoring during a rollback

Watch the error-rate dashboard and the health check panel for five minutes
after the alias flip. If the alert doesn't clear in that window, escalate.

## Access and permissions

Only on-call engineers and the platform team can flip the deployment alias.
Everyone else should page on-call instead of trying it themselves.

## Communication

Post a one-line status update in the incident channel the moment the
rollback starts, and another once the health check turns green.

## Runbook FAQ

**Q: Where's the rollback procedure again?**
${X}

**Q: What if the previous tag also fails health checks?**
Stop and escalate — see below.

## Escalation

Page the on-call engineer if the rollback itself fails.`,F="once again — where’s the rollback procedure stated?",I='couplet show runbook.md --find "previous tag"',N="found it — 2 mentions, pulsing each",te=34,D=16,ne=350,oe=200,ie=450,U=700,H=1800,re=700;function Q(e,n){const i=new MutationObserver(()=>{e.isConnected||(i.disconnect(),n())});i.observe(document.body,{childList:!0,subtree:!0})}function se(e){e.textContent="";function n(u,b){const v=document.createElement("div");v.className=`point-chrome-line point-chrome-line--${u}`;const d=document.createElement("span");d.className="point-chrome-tag",d.textContent=b;const o=document.createElement("span");return o.className="point-chrome-text",v.append(d,o),{line:v,text:o}}const i=n("user","you"),w=n("cmd","agent"),g=n("note","→");return e.append(i.line,w.line,g.line),{user:i.text,cmd:w.text,note:g.text}}function W(e,n){return Math.max(0,e.lineBlockAt(n).top)}function ae(e){return e<.5?4*e*e*e:1-(-2*e+2)**3/2}function de(e){const{view:n,destroy:i}=J(e,{doc:ee}),w=P(n.state,{line:null,find:q}),g=P(n.state,{line:null,find:X});if(w===null||g===null)return;const u=w,b=g,v=n.state.doc.length,d=e.closest(".slide")?.querySelector('[data-demo-chrome="point"]'),o=d?se(d):null;function Y(t,s){const r=window.scrollX,a=window.scrollY,c=()=>{(window.scrollX!==r||window.scrollY!==a)&&window.scrollTo({left:r,top:a,behavior:"instant"})};window.addEventListener("scroll",c,{passive:!0}),t(),window.setTimeout(()=>window.removeEventListener("scroll",c),s)}function k(t){n.dispatch({effects:y.of(null)}),requestAnimationFrame(()=>{Y(()=>{n.dispatch({selection:{anchor:v},effects:[z.scrollIntoView(t,{y:"nearest"}),Z.of(t)]})},600)})}if(K()){o&&(o.user.textContent=F,o.cmd.textContent=I,o.note.textContent=N),n.scrollDOM.scrollTop=W(n,u),k(u),Q(e,i);return}let l=0,f,h;function m(t,s){return new Promise(r=>{f=window.setTimeout(()=>{f=void 0,r(s===l)},t)})}function T(t,s,r,a){return t.textContent="",new Promise(c=>{let p=0;const A=()=>{if(a!==l){c(!1);return}if(p>=s.length){c(!0);return}p+=1,t.textContent=s.slice(0,p),f=window.setTimeout(A,r)};A()})}function C(t,s,r){return new Promise(a=>{const c=n.scrollDOM,p=c.scrollTop,O=W(n,t)-p;if(Math.abs(O)<1){a(r===l);return}const V=performance.now(),R=j=>{if(r!==l){a(!1);return}const x=Math.min(1,(j-V)/s);c.scrollTop=p+O*ae(x),x<1?h=requestAnimationFrame(R):(h=void 0,a(!0))};h=requestAnimationFrame(R)})}async function $(t){for(;;)if(n.dispatch({effects:y.of(null)}),o&&(o.user.textContent="",o.cmd.textContent="",o.note.textContent="",!await T(o.user,F,te,t)||!await m(ne,t)||!await T(o.cmd,I,D,t)||!await m(oe,t)||!await T(o.note,N,D,t))||!await m(ie,t)||!await C(u,U,t)||(k(u),!await m(H,t))||!await C(b,U,t)||(k(b),!await m(H,t))||!await m(re,t))return}let E=!1;function M(){E&&(E=!1,l+=1,f!==void 0&&(window.clearTimeout(f),f=void 0),h!==void 0&&(cancelAnimationFrame(h),h=void 0))}function B(){E||(E=!0,l+=1,$(l))}let _=!1;function S(){_&&!document.hidden?B():M()}const L=new IntersectionObserver(t=>{_=t[t.length-1]?.isIntersecting??!1,S()});L.observe(e),document.addEventListener("visibilitychange",S),Q(e,()=>{M(),L.disconnect(),document.removeEventListener("visibilitychange",S),i()})}export{de as mount};
