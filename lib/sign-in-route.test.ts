import { describe,expect,it } from 'vitest';
import { GET } from '../app/auth/sign-in/route';

describe('Aplyd Pages sign-in entry',()=>{
 it('renders the branded Aplyd entry before starting OIDC',async()=>{
  const response=await GET(new Request('https://holy-sheet.example/auth/sign-in?next=%2Fpages%2Fwelcome'));
  const body=await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toMatch(/style-src 'nonce-[^']+'/);
  expect(body).toContain('Give every idea a place to belong.');
  expect(body).toContain('Continue with Aplyd');
  expect(body).toContain('src="/brand/little-bot-heroes/holy-sheet.png"');
  expect(body).toContain('drop-shadow(1px 0 0 #fff8e9)');
  expect(body).not.toContain('aria-hidden="true">✦</span>');
  expect(body).toContain('/auth/sign-in?continue=1&amp;next=%2Fpages%2Fwelcome');
 });

 it('does not carry a foreign return URL into the continue action',async()=>{
  const response=await GET(new Request('https://holy-sheet.example/auth/sign-in?next=https%3A%2F%2Fevil.example'));
  const body=await response.text();
  expect(body).toContain('/auth/sign-in?continue=1&amp;next=%2F');
  expect(body).not.toContain('evil.example');
 });

 it('keeps the unconfigured OIDC transition fail-closed',async()=>{
  const response=await GET(new Request('https://holy-sheet.example/auth/sign-in?continue=1'));
  expect(response.status).toBe(503);
 });
});
