import {DocumentError} from './document';

export type SearchWork={check():void};
export function createSearchWork(duration=5000,signal?:AbortSignal):SearchWork{
 const deadline=performance.now()+duration;
 return {check(){if(signal?.aborted||performance.now()>=deadline)throw new DocumentError('Search is temporarily busy. Retry or choose a space.','search_busy',503);}};
}
