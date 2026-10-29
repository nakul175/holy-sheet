import {defineConfig} from '@playwright/test';
import shared from './playwright.accessibility.config';
const server=shared.webServer;if(!server||Array.isArray(server))throw new Error('Expected one isolated browser server');
const origin='http://127.0.0.1:53346';
export default defineConfig({...shared,testMatch:['whole-word-find.spec.ts'],outputDir:'test-results/holy146',use:{...shared.use,baseURL:origin},webServer:{...server,command:server.command.replace('--port 53300','--port 53346'),url:origin,env:{...server.env,HS_ORIGIN:origin}}});
