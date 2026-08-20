import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
  turbopack: {
    root: process.cwd(),
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "chrismorell.xyz" }],
        destination: "https://www.chrismorell.xyz/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
