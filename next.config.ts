import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
