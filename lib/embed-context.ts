export type EmbedContext={kind:'standalone'}|{kind:'restricted';userId:string}|{kind:'missing'};
/** An account hint only restricts rendering; it never authenticates or grants access. */
export function embedContext(fragment:string,framed:boolean):EmbedContext{
  const values=new URLSearchParams(fragment.replace(/^#/, '')).getAll('hs-user');
  if(!values.length)return framed?{kind:'missing'}:{kind:'standalone'};
  if(values.length!==1||!values[0].length||values[0].length>200||/[\u0000-\u0020\u007f]/.test(values[0]))return {kind:'missing'};
  return {kind:'restricted',userId:values[0]};
}
