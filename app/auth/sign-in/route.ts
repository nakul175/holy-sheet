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
:root{--navy:#2c2f71;--navy-dark:#1f2252;--gold:#d99d29;--bg:#f5f6f8;--card:#fff;--line:#e3e6eb;--ink:#171b22;--ink-2:#3a4250;--muted:#5e6673;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--ink)}main{min-height:100vh;min-height:100dvh;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(420px,.92fr)}
.story{position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:80px clamp(44px,7vw,110px);background:var(--navy);color:#fff}
.brand{position:absolute;top:38px;left:clamp(44px,7vw,110px);display:flex;align-items:center;gap:11px;color:#fff;font-size:15px;font-weight:720;letter-spacing:-.01em}.mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid #ffffff30;border-radius:10px;background:var(--gold);color:var(--navy-dark);box-shadow:0 9px 24px #11143c55;font-size:15px}.suite{color:#ffffffa8;font-weight:520}
.copy{position:relative;z-index:2;max-width:630px}.eyebrow{display:flex;align-items:center;gap:12px;margin:0 0 25px;color:#f1c66f;font-size:11px;font-weight:760;letter-spacing:.17em;text-transform:uppercase}.eyebrow:before{content:"";width:34px;height:2px;border-radius:2px;background:var(--gold)}.copy h1{max-width:610px;margin:0;color:#fff;font-size:clamp(48px,5.6vw,78px);font-weight:640;letter-spacing:-.055em;line-height:.98}.copy p{max-width:460px;margin:28px 0 0;color:#ffffffba;font-size:18px;line-height:1.55}
.canvas{position:absolute;right:-86px;bottom:-98px;width:440px;height:410px;opacity:.92}.sheet{position:absolute;width:154px;height:202px;border:1px solid #ffffff30;border-radius:18px;background:#ffffff0c;box-shadow:0 24px 70px #11143c50;backdrop-filter:blur(2px)}.sheet:before{content:"";position:absolute;left:22px;right:22px;top:28px;height:6px;border-radius:6px;background:#ffffff3a;box-shadow:0 23px 0 #ffffff21,0 46px 0 #ffffff21}.sheet:after{content:"";position:absolute;left:22px;bottom:25px;width:52px;height:6px;border-radius:6px;background:var(--gold)}.s1{left:16px;top:124px;transform:rotate(-11deg)}.s2{left:124px;top:48px;transform:rotate(5deg);background:#ffffff12}.s3{left:236px;top:150px;transform:rotate(13deg)}.sun{position:absolute;width:260px;height:260px;right:5px;top:20px;border:1px solid #d99d2950;border-radius:50%}.sun:before,.sun:after{content:"";position:absolute;border:1px solid #d99d2935;border-radius:50%}.sun:before{inset:44px}.sun:after{inset:92px;background:var(--gold);border:0;opacity:.95}
.access{position:relative;display:flex;align-items:center;justify-content:center;padding:54px clamp(32px,6vw,88px);background:var(--bg)}.card{width:min(410px,100%);padding:42px;border:1px solid var(--line);border-radius:20px;background:var(--card);box-shadow:0 24px 70px #21244a12}.card h2{margin:0;color:var(--navy);font-size:31px;font-weight:650;letter-spacing:-.035em}.lead{margin:12px 0 30px;color:var(--muted);font-size:15px;line-height:1.6}.continue{display:flex;align-items:center;justify-content:space-between;min-height:56px;width:100%;padding:0 19px;border:1px solid var(--navy);border-radius:10px;background:var(--navy);color:#fff;font-size:15px;font-weight:680;text-decoration:none;box-shadow:inset 4px 0 0 var(--gold),0 10px 22px #2c2f7123;transition:transform .16s,box-shadow .16s,background .16s}.continue:hover{background:var(--navy-dark);box-shadow:inset 4px 0 0 var(--gold),0 14px 28px #2c2f7130;transform:translateY(-1px)}.continue:focus-visible{outline:3px solid var(--gold);outline-offset:4px}.arrow{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#ffffff14;font-size:18px;font-weight:400}.trust{display:flex;align-items:flex-start;gap:10px;margin:22px 2px 0;color:var(--muted);font-size:12px;line-height:1.55}.shield{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#fff6e2;color:#8a5a00;font-size:11px}.foot{position:absolute;right:clamp(32px,6vw,88px);bottom:28px;color:#8d93a0;font-size:11px}
@media(max-width:820px){main{display:block}.story{min-height:46vh;padding:96px 24px 54px}.brand{top:25px;left:24px}.copy h1{font-size:45px;max-width:490px}.copy p{font-size:15px;margin-top:19px;max-width:400px}.eyebrow{margin-bottom:17px}.canvas{width:270px;height:240px;right:-115px;bottom:-105px;opacity:.7}.sheet{display:none}.sun{width:220px;height:220px}.access{min-height:54vh;padding:36px 20px 72px}.card{padding:30px;border-radius:16px}.foot{position:static;margin-top:38px;text-align:center}}
@media(max-width:460px){.story{min-height:auto;padding-top:88px}.suite{display:none}.copy h1{font-size:39px}.copy p{font-size:14px}.access{align-items:flex-start}.card{padding:26px 22px}.card h2{font-size:27px}}
@media(prefers-reduced-motion:reduce){.continue{transition:none}}
</style></head><body><main>
<section class="story" aria-labelledby="holy-sheet-heading"><div class="brand"><span class="mark" aria-hidden="true">✦</span><span>Holy Sheet</span><span class="suite">· Aplyd</span></div><div class="copy"><p class="eyebrow">Shared knowledge, beautifully organised</p><h1 id="holy-sheet-heading">Give every idea a place to belong.</h1><p>Pages, records and working knowledge—connected across your Aplyd suite.</p></div><div class="canvas" aria-hidden="true"><div class="sun"></div><div class="sheet s1"></div><div class="sheet s2"></div><div class="sheet s3"></div></div></section>
<section class="access" aria-labelledby="sign-in-heading"><div class="card"><h2 id="sign-in-heading">Welcome back</h2><p class="lead">Use your Aplyd account to continue to Holy Sheet.</p><a class="continue" href="${escape(destination)}"><span>Continue with Aplyd</span><span class="arrow" aria-hidden="true">→</span></a><p class="trust"><span class="shield" aria-hidden="true">✓</span><span>One secure sign-in for the applications your organisation has assigned to you.</span></p><p class="foot">Aplyd productivity suite</p></div></section>
</main></body></html>`,{headers});
}

export const GET=(request:Request)=>{
 const incoming=new URL(request.url);
 return incoming.searchParams.get('continue')==='1'?oidcRoute('signIn',request):signInPage(request);
};
