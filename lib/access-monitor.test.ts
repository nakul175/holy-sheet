// @vitest-environment jsdom
import {describe,it,expect,vi,afterEach} from 'vitest';
import {monitorAccess,announceSharingChange} from './access-monitor';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();localStorage.clear();});
describe('active page access monitor',()=>{
 it('checks without an edit, reacts to cross-tab grants and does not overlap requests',async()=>{
  vi.useFakeTimers();let release!:(v:string)=>void;const check=vi.fn((_signal:AbortSignal)=>new Promise<string>(r=>{release=r;})),receive=vi.fn(),fail=vi.fn();const stop=monitorAccess(check,receive,fail);
  expect(check).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(2000);expect(check).toHaveBeenCalledTimes(1);
  release('viewer');await Promise.resolve();await Promise.resolve();expect(receive).toHaveBeenCalledWith('viewer');expect(check).toHaveBeenCalledTimes(2);
  release('editor');await Promise.resolve();await Promise.resolve();window.dispatchEvent(new StorageEvent('storage',{key:'hs-sharing-recheck',newValue:'changed'}));expect(check).toHaveBeenCalledTimes(3);stop();expect(check.mock.calls[2][0].aborted).toBe(true);release('owner');await Promise.resolve();expect(receive).not.toHaveBeenCalledWith('owner');
 });
 it('pauses on a hung request rather than trusting stale access indefinitely',async()=>{vi.useFakeTimers();const check=vi.fn((_signal:AbortSignal)=>new Promise<string>(()=>{})),fail=vi.fn();const stop=monitorAccess(check,vi.fn(),fail);await vi.advanceTimersByTimeAsync(5000);expect(check.mock.calls[0][0].aborted).toBe(true);expect(fail).toHaveBeenCalledOnce();stop();});
 it('reports unavailable checks, retries on focus/online and releases every listener on cleanup',async()=>{
  vi.useFakeTimers();const check=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('viewer'),receive=vi.fn(),fail=vi.fn();const stop=monitorAccess(check,receive,fail);await Promise.resolve();await Promise.resolve();expect(fail).toHaveBeenCalledOnce();window.dispatchEvent(new Event('focus'));await Promise.resolve();await Promise.resolve();expect(receive).toHaveBeenCalledWith('viewer');stop();const count=check.mock.calls.length;await vi.advanceTimersByTimeAsync(3000);window.dispatchEvent(new Event('online'));announceSharingChange();expect(check).toHaveBeenCalledTimes(count);
 });
 it('rechecks on return from a hidden tab and emits no page identities in storage announcements',async()=>{
  vi.useFakeTimers();const visible=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden'),check=vi.fn().mockResolvedValue('viewer');const stop=monitorAccess(check,vi.fn(),vi.fn());await vi.advanceTimersByTimeAsync(3000);expect(check).not.toHaveBeenCalled();visible.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();expect(check).toHaveBeenCalledOnce();announceSharingChange();expect(localStorage.getItem('hs-sharing-recheck')).toMatch(/^[a-f0-9-]{36}$/);stop();
 });
});
