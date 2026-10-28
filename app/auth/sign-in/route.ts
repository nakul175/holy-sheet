import { randomBytes } from 'node:crypto';
import { safeSignInReturn } from '../../../lib/auth-paths';
import { oidcRoute } from '../../../lib/oidc-bridge';

const escape=(value:string)=>value.replace(/[&<>"']/g,character=>({
 '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
})[character]!);

function signInPage(request:Request){
 const incoming=new URL(request.url),next=safeSignInReturn(incoming.searchParams.get('next'));
 const nonce=randomBytes(18).toString('base64');
 const destination=`/auth/sign-in?continue=1&next=${encodeURIComponent(next)}`;
 const headers={
  'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
  'Content-Type':'text/html; charset=utf-8',
  'Content-Security-Policy':`default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
 };
 return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Holy Sheet</title><style nonce="${nonce}">
:root{--navy:#202443;--purple:#6257d9;--purple-dark:#5147c6;--gold:#dfa626;--ink:#25263a;--muted:#6d7085;--line:#e3e4ec;--mist:#f6f6fa;--white:#fff;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;background:var(--white);color:var(--ink)}main{min-height:100vh;min-height:100dvh;display:grid;grid-template-columns:minmax(0,1.18fr) minmax(420px,.82fr)}
.story{position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:72px clamp(42px,7vw,112px);background:linear-gradient(145deg,#f8f7ff 0%,#fff 48%,#faf7ef 100%)}
.brand{position:absolute;top:34px;left:clamp(42px,7vw,112px);display:flex;align-items:center;gap:11px;color:var(--navy);font-size:15px;font-weight:720;letter-spacing:-.01em}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--navy);color:#fff;box-shadow:0 7px 18px #20244329;font-size:14px}.suite{color:var(--muted);font-weight:520}
.copy{position:relative;z-index:1;max-width:620px}.eyebrow{margin:0 0 22px;color:var(--purple);font-size:11px;font-weight:760;letter-spacing:.16em;text-transform:uppercase}.copy h1{max-width:590px;margin:0;color:var(--navy);font-size:clamp(46px,5.4vw,76px);font-weight:650;letter-spacing:-.055em;line-height:.98}.copy p{max-width:470px;margin:26px 0 0;color:var(--muted);font-size:18px;line-height:1.55}
.orbit{position:absolute;right:-120px;bottom:-160px;width:520px;height:520px;border:1px solid #6257d91f;border-radius:50%}.orbit:before,.orbit:after{content:"";position:absolute;border:1px solid #6257d91f;border-radius:50%}.orbit:before{inset:72px}.orbit:after{inset:150px;background:#ffffff73}.page{position:absolute;width:118px;height:150px;border:1px solid #deddea;border-radius:15px;background:#ffffffd9;box-shadow:0 18px 42px #3d37651c;transform:rotate(-8deg)}.page:before,.page:after{content:"";position:absolute;left:18px;right:18px;height:5px;border-radius:5px;background:#e5e3f4}.page:before{top:24px;box-shadow:0 18px 0 #ecebf5,0 36px 0 #ecebf5}.page:after{bottom:22px;right:48px;background:#ddd9fb}.p1{right:96px;bottom:102px}.p2{right:18px;bottom:44px;transform:rotate(9deg)}
.access{display:flex;align-items:center;justify-content:center;padding:48px clamp(28px,5vw,74px);border-left:1px solid var(--line);background:#fff}.card{width:min(390px,100%)}.card .mobile-brand{display:none}.card h2{margin:0;color:var(--navy);font-size:30px;font-weight:650;letter-spacing:-.035em}.lead{margin:12px 0 30px;color:var(--muted);font-size:15px;line-height:1.6}.continue{display:flex;align-items:center;justify-content:space-between;min-height:54px;width:100%;padding:0 18px;border:1px solid var(--navy);border-radius:12px;background:var(--navy);color:#fff;font-size:15px;font-weight:680;text-decoration:none;box-shadow:0 9px 22px #20244324;transition:transform .16s,box-shadow .16s,background .16s}.continue:hover{background:#2c315b;box-shadow:0 13px 28px #2024432e;transform:translateY(-1px)}.continue:focus-visible{outline:3px solid var(--gold);outline-offset:4px}.arrow{font-size:20px;font-weight:400}.trust{display:flex;align-items:flex-start;gap:10px;margin:22px 2px 0;color:var(--muted);font-size:12px;line-height:1.55}.shield{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#f0effb;color:var(--purple);font-size:11px}.foot{position:absolute;right:clamp(28px,5vw,74px);bottom:28px;color:#9a9cac;font-size:11px}
@media(max-width:820px){main{display:block}.story{min-height:43vh;padding:94px 24px 44px}.brand{top:24px;left:24px}.copy h1{font-size:44px;max-width:470px}.copy p{font-size:15px;margin-top:18px}.eyebrow{margin-bottom:16px}.orbit{width:330px;height:330px;right:-150px;bottom:-180px}.page{display:none}.access{min-height:57vh;border:0;border-top:1px solid var(--line);padding:40px 24px 72px}.foot{position:static;margin-top:42px;text-align:center}}
@media(max-width:460px){.story{min-height:auto;padding-top:88px}.suite{display:none}.copy h1{font-size:38px}.copy p{font-size:14px}.access{align-items:flex-start}.card h2{font-size:27px}}
@media(prefers-reduced-motion:reduce){.continue{transition:none}}
</style></head><body><main>
<section class="story" aria-labelledby="holy-sheet-heading"><div class="brand"><span class="mark" aria-hidden="true">✦</span><span>Holy Sheet</span><span class="suite">· Aplyd</span></div><div class="copy"><p class="eyebrow">A clearer place for shared knowledge</p><h1 id="holy-sheet-heading">Everything finds its place.</h1><p>Pages, records and working knowledge—connected across your Aplyd suite.</p></div><div class="orbit" aria-hidden="true"></div><div class="page p1" aria-hidden="true"></div><div class="page p2" aria-hidden="true"></div></section>
<section class="access" aria-labelledby="sign-in-heading"><div class="card"><h2 id="sign-in-heading">Welcome back</h2><p class="lead">Use your Aplyd account to continue to Holy Sheet.</p><a class="continue" href="${escape(destination)}"><span>Continue with Aplyd</span><span class="arrow" aria-hidden="true">→</span></a><p class="trust"><span class="shield" aria-hidden="true">✓</span><span>One secure sign-in for the applications your organisation has assigned to you.</span></p><p class="foot">Aplyd productivity suite</p></div></section>
</main></body></html>`,{headers});
}

export const GET=(request:Request)=>{
 const incoming=new URL(request.url);
 return incoming.searchParams.get('continue')==='1'?oidcRoute('signIn',request):signInPage(request);
};
