import type { NextConfig } from "next";

const nextConfig: NextConfig = { output:"standalone", serverExternalPackages: ["@electric-sql/pglite", "jsdom"], poweredByHeader: false };
export default nextConfig;
