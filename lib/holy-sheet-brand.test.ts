import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import HolySheetBrand from '../components/holy-sheet-brand';

describe('Little Bot Heroes brand mark',()=>{
 it('keeps the supplied PNG alpha channel',()=>{
  const png=readFileSync('public/brand/little-bot-heroes/pages.png');
  expect(png.subarray(1,4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1254);
  expect(png.readUInt32BE(20)).toBe(1254);
  expect(png[25]).toBe(6);
 });

 it('ships transparent browser and Apple icons from the same mark',()=>{
  for(const [path,size] of [['app/icon.png',64],['app/apple-icon.png',180]] as const){
   const png=readFileSync(path);
   expect(png.subarray(1,4).toString()).toBe('PNG');
   expect(png.readUInt32BE(16)).toBe(size);
   expect(png.readUInt32BE(20)).toBe(size);
   expect(png[25]).toBe(6);
  }
 });

 it('adds the ivory-edge treatment only on navy',()=>{
  const white=renderToStaticMarkup(createElement(HolySheetBrand));
  const navy=renderToStaticMarkup(createElement(HolySheetBrand,{onBlue:true}));
  expect(white).toContain('class="aplyd-bot holy-sheet-brand-logo"');
  expect(white).not.toContain('aplyd-bot--on-blue');
  expect(navy).toContain('aplyd-bot--on-blue');
  expect(navy).toContain('alt=""');
 });
});
