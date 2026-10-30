import {describe,expect,it} from 'vitest';
import {findLiteralRanges} from '../components/editor/find-matches';

describe('literal whole-word matching',()=>{
  it('uses Unicode word edges while preserving UTF-16 offsets',()=>{
    const value='👋cat catalog café cafés 中文 中文词 42 420 item_1 item_10 e\u0301 e\u0301lan';
    expect(findLiteralRanges(value,'cat',{wholeWords:true})).toEqual([{index:2,length:3}]);
    for(const query of ['café','中文','42','item_1','e\u0301'])expect(findLiteralRanges(value,query,{wholeWords:true})).toHaveLength(1);
    expect(findLiteralRanges('A.B a.b axb','a.b',{wholeWords:true})).toEqual([{index:0,length:3},{index:4,length:3}]);
    expect(findLiteralRanges('A.B a.b','a.b',{matchCase:true,wholeWords:true})).toEqual([{index:4,length:3}]);
  });
  it('stays bounded for large regex-shaped input and repeated toggles',()=>{
    const value=('catalog cat aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa! '.repeat(5000));
    const started=performance.now();
    for(let i=0;i<20;i++)expect(findLiteralRanges(value,i%2?'cat':'a+a+a+a+a+a+a+a',{wholeWords:!!(i%2)}).length).toBeGreaterThanOrEqual(0);
    expect(performance.now()-started).toBeLessThan(1500);
  });
});
