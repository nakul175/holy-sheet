import {defineConfig} from '@playwright/test';
import shared from './playwright.accessibility.config';
const server=shared.webServer;if(!server||Array.isArray(server))throw new Error('Expected one isolated browser server');
const origin='http://127.0.0.1:53335';
export default defineConfig({...shared,testMatch:['table-position.spec.ts'],outputDir:'test-results/holy135',use:{...shared.use,baseURL:origin},webServer:{...server,command:server.command.replace('--port 53300','--port 53335'),url:origin,env:{...server.env,HS_ORIGIN:origin}}});
