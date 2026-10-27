export function safeSignInReturn(value:string|null){return value&&value.length<=240&&/^\/(?:pages\/[A-Za-z0-9_-]+|embed\/pages\/[A-Za-z0-9_-]+)?$/.test(value)?value:'/';}
