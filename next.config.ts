import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Provisioning and firewall setup load these artifacts by name at runtime.
  outputFileTracingIncludes: { "/api/**/*": ["./templates/**/*"] },
  // ssh2 ships a native addon (sshcrypto.node) — it must stay a runtime
  // require on the server, never webpack-bundled.
  serverExternalPackages: ["ssh2"],
  poweredByHeader: false,
  // Security headers are set at REQUEST time in middleware.ts, not here:
  // next.config headers() is frozen at build time, so a build without
  // INSTANCE_DOMAIN would ship a CSP that silently blocks the Studio iframe.
};

export default nextConfig;
