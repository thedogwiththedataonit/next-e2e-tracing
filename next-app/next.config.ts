import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@datadog/datadog-api-client"],
};

export default nextConfig;
