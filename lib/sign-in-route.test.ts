import { describe,expect,it } from 'vitest';
import { GET } from '../app/auth/sign-in/route';

describe('Holy Sheet sign-in entry',()=>{
 it('renders the branded Aplyd entry before starting OIDC',async()=>{
  const response=await GET(new Request('https://holy-sheet.example/auth/sign-in?next=%2Fpages%2Fwelcome'));
  const body=await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toMatch(/style-src 'nonce-[^']+'/);
  expect(body).toContain('Give every idea a place to belong.');
  expect(body).toContain('Continue with Aplyd');
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
