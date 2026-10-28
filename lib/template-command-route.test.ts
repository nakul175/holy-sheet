import {describe,expect,it} from 'vitest';
import {templateCommandSchema} from './template-command-schema';

describe('template command boundary',()=>{
  const valid={kind:'publish-space',operationId:'0f5696fe-faa8-4bc0-8f86-e68ae5401278',id:'template-1',expectedDraftVersion:2,spaceId:'space-product',reviewed:true};

  it('accepts the reviewed shared-space publication emitted by the template dialog',()=>{
    expect(templateCommandSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unreviewed or shape-expanded shared publication requests',()=>{
    expect(templateCommandSchema.safeParse({...valid,reviewed:false}).success).toBe(false);
    expect(templateCommandSchema.safeParse({...valid,extra:'unexpected'}).success).toBe(false);
  });
});
