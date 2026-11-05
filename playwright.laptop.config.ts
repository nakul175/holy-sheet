import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/acceptance',testMatch:'laptop-design.spec.ts',workers:1,retries:0,timeout:90000,expect:{timeout:20000},reporter:'list',outputDir:'test-results/laptop',use:{baseURL:process.env.HS_LAPTOP_TEST_ORIGIN||'http://127.0.0.1:3531',screenshot:'only-on-failure',trace:'retain-on-failure'}});
