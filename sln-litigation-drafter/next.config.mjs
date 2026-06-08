/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "docx",
      "@anthropic-ai/sdk",
      "@azure/identity",
      "@azure/core-rest-pipeline",
      "@azure/core-auth",
      "@microsoft/microsoft-graph-client",
      "mammoth",
    ],
  },
};

export default nextConfig;
