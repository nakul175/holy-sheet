import { afterEach,it,expect,vi } from 'vitest';
import { getObject,deleteObject } from './media';
afterEach(()=>vi.unstubAllEnvs());
it('refuses insecure production object-storage endpoints before transmitting credentials or file requests',async()=>{vi.stubEnv('NODE_ENV','production');vi.stubEnv('S3_BUCKET','isolated-config-test');vi.stubEnv('S3_ENDPOINT','http://storage.example.invalid');const key=crypto.randomUUID();await expect(getObject(key)).rejects.toMatchObject({code:'storage_configuration',status:503});await expect(deleteObject(key)).rejects.toMatchObject({code:'storage_configuration',status:503});});
