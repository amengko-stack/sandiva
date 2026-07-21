/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Keep native/wasm server deps out of the bundler.
    serverComponentsExternalPackages: ["@electric-sql/pglite", "pdfkit"],
  },
};

export default nextConfig;
