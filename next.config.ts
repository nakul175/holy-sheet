import type { NextConfig } from "next";

const nextConfig: NextConfig = { output:"standalone", serverExternalPackages: ["@electric-sql/pglite", "jsdom"], poweredByHeader: false,
  async headers(){return [{source:'/',headers:[{key:'Content-Security-Policy',value:"frame-ancestors 'none'"}]},{source:'/workspaces',headers:[{key:'Content-Security-Policy',value:"frame-ancestors 'none'"}]},{source:'/pages/:path*',headers:[{key:'Content-Security-Policy',value:"frame-ancestors 'none'"}]},{source:'/p/:path*',headers:[{key:'Content-Security-Policy',value:"frame-ancestors 'none'"}]},{source:'/s/:path*',headers:[{key:'Content-Security-Policy',value:"frame-ancestors 'none'"}]},{source:'/embed/:path*',headers:[{key:'Content-Security-Policy',value:"frame-ancestors 'self' https://sheethappensofficer.aplyd.org https://sho-qa.aplyd.org"}]}];},
};
export default nextConfig;
