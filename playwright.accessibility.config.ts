import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/acceptance',testMatch:['editor-accessibility.spec.ts','personal-navigation-backlinks.spec.ts','document-import.spec.ts','page-export.spec.ts','connected-search-picker.spec.ts','record-layout.spec.ts','workspace-operations.spec.ts','page-outline.spec.ts'],workers:1,retries:0,
  timeout:120000,expect:{timeout:20000},reporter:'list',outputDir:'test-results/accessibility',
  use:{baseURL:'http://127.0.0.1:53300',trace:'off',screenshot:'only-on-failure',launchOptions:{executablePath:process.env.PW_CHROMIUM}},
  webServer:{command:'node --import tsx scripts/seed-browser-acceptance.mts && npm run build:import && npm run build:export && npm run dev -- --hostname 127.0.0.1 --port 53300',url:'http://127.0.0.1:53300',timeout:120000,reuseExistingServer:false,
    env:{HS_ACCEPTANCE_SEED:'1',HS_LOCAL_DATABASE_DIR:'.holy-sheet/browser-acceptance',HS_LOCAL_PREVIEW:'1',HS_RICH_EDITOR_ENABLED:'1',HS_ORIGIN:'http://127.0.0.1:53300',HS_OIDC_ENABLED:'0',DATABASE_URL:'',NEXT_TELEMETRY_DISABLED:'1'}},
});
