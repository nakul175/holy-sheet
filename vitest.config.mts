import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["lib/**/*.test.ts"],maxWorkers:1,testTimeout:20000,hookTimeout:30000}});
