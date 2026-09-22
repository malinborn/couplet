import{E as z}from"./mermaid-CKz8Oxa3.js";import{m as J,p as K,c as y,B as Z}from"./editor-demo-UkFoCeUZ.js";import"./index-B4dY-qQm.js";function P(n,t){if(t.line!==null){const i=Math.min(Math.max(t.line,1),n.doc.lines);return n.doc.line(i).from}if(t.find!==null){const i=n.doc.toString().indexOf(t.find);return i===-1?null:i}return 0}const q="Rollbacks re-deploy the previous tag.",B="Re-deploy the previous tag, nothing else.",G=`# Rollback runbook

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
${B}

**Q: What if the previous tag also fails health checks?**
Stop and escalate — see below.

## Escalation

Page the on-call engineer if the rollback itself fails.`,F="once again — where’s the rollback procedure stated?",I='couplet show runbook.md --find "previous tag"',N="found it — 2 mentions, pulsing each",ee=34,D=16,te=350,ne=200,oe=450,U=700,H=1800,ie=700;function Q(n,t){const i=new MutationObserver(()=>{n.isConnected||(i.disconnect(),t())});i.observe(document.body,{childList:!0,subtree:!0})}function re(n){n.textContent="";function t(u,b){const v=document.createElement("div");v.className=`point-chrome-line point-chrome-line--${u}`;const d=document.createElement("span");d.className="point-chrome-tag",d.textContent=b;const o=document.createElement("span");return o.className="point-chrome-text",v.append(d,o),{line:v,text:o}}const i=t("user","you"),w=t("cmd","agent"),g=t("note","→");return n.append(i.line,w.line,g.line),{user:i.text,cmd:w.text,note:g.text}}function W(n,t){return Math.max(0,n.lineBlockAt(t).top)}function se(n){return n<.5?4*n*n*n:1-(-2*n+2)**3/2}function ue(n){const{view:t,destroy:i}=J(n,{doc:G}),w=P(t.state,{line:null,find:q}),g=P(t.state,{line:null,find:B});if(w===null||g===null)return;const u=w,b=g,v=t.state.doc.length,d=n.closest(".slide")?.querySelector('[data-demo-chrome="point"]'),o=d?re(d):null;function X(e,s){const r=window.scrollX,a=window.scrollY,c=()=>{(window.scrollX!==r||window.scrollY!==a)&&window.scrollTo({left:r,top:a,behavior:"instant"})};window.addEventListener("scroll",c,{passive:!0}),e(),window.setTimeout(()=>window.removeEventListener("scroll",c),s)}function E(e){t.dispatch({effects:y.of(null)}),requestAnimationFrame(()=>{X(()=>{t.dispatch({selection:{anchor:v},effects:[z.scrollIntoView(e,{y:"nearest"}),Z.of(e)]})},600)})}if(K()){o&&(o.user.textContent=F,o.cmd.textContent=I,o.note.textContent=N),t.scrollDOM.scrollTop=W(t,u),E(u),Q(n,i);return}let l=0,f,h;function m(e,s){return new Promise(r=>{f=window.setTimeout(()=>{f=void 0,r(s===l)},e)})}function T(e,s,r,a){return e.textContent="",new Promise(c=>{let p=0;const A=()=>{if(a!==l){c(!1);return}if(p>=s.length){c(!0);return}p+=1,e.textContent=s.slice(0,p),f=window.setTimeout(A,r)};A()})}function C(e,s,r){return new Promise(a=>{const c=t.scrollDOM,p=c.scrollTop,O=W(t,e)-p;if(Math.abs(O)<1){a(r===l);return}const V=performance.now(),R=j=>{if(r!==l){a(!1);return}const L=Math.min(1,(j-V)/s);c.scrollTop=p+O*se(L),L<1?h=requestAnimationFrame(R):(h=void 0,a(!0))};h=requestAnimationFrame(R)})}async function Y(e){for(;;)if(t.dispatch({effects:y.of(null)}),o&&(o.user.textContent="",o.cmd.textContent="",o.note.textContent="",!await T(o.user,F,ee,e)||!await m(te,e)||!await T(o.cmd,I,D,e)||!await m(ne,e)||!await T(o.note,N,D,e))||!await m(oe,e)||!await C(u,U,e)||(E(u),!await m(H,e))||!await C(b,U,e)||(E(b),!await m(H,e))||!await m(ie,e))return}let k=!1;function M(){k&&(k=!1,l+=1,f!==void 0&&(window.clearTimeout(f),f=void 0),h!==void 0&&(cancelAnimationFrame(h),h=void 0))}function $(){k||(k=!0,l+=1,Y(l))}let _=!1;function S(){_&&!document.hidden?$():M()}const x=new IntersectionObserver(e=>{_=e[e.length-1]?.isIntersecting??!1,S()});x.observe(n),document.addEventListener("visibilitychange",S),Q(n,()=>{M(),x.disconnect(),document.removeEventListener("visibilitychange",S),i()})}export{ue as mount};
