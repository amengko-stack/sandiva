/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Keep native/wasm server deps out of the bundler.
    serverComponentsExternalPackages: ["@electric-sql/pglite", "pdfkit"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            // Allow Microsoft Teams / Microsoft 365 shells to embed the app
            // as a tab; every other site is blocked from framing us.
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://*.skype.com https://*.microsoft365.com https://*.cloud.microsoft",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
