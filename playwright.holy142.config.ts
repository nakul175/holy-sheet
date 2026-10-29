import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/acceptance',testMatch:'reading-guide.spec.ts',workers:1,retries:0,timeout:120000,expect:{timeout:20000},reporter:'list',outputDir:'test-results/holy142',
  use:{baseURL:'http://127.0.0.1:53345',trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{executablePath:process.env.PW_CHROMIUM}},
  webServer:{command:'node --import tsx scripts/seed-browser-acceptance.mts && npm run build:editor && npm run build:import && npm run build:export && npm run dev -- --hostname 127.0.0.1 --port 53345',url:'http://127.0.0.1:53345',timeout:120000,reuseExistingServer:false,
    env:{HS_ACCEPTANCE_SEED:'1',HS_LOCAL_DATABASE_DIR:'.holy-sheet/browser-acceptance',HS_LOCAL_PREVIEW:'1',HS_RICH_EDITOR_ENABLED:'1',HS_COLLABORATION_ENABLED:'0',HS_ORIGIN:'http://127.0.0.1:53345',HS_OIDC_ENABLED:'0',DATABASE_URL:'',NEXT_TELEMETRY_DISABLED:'1'}},
});
