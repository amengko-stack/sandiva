/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "docx",
      "@anthropic-ai/sdk",
      "mammoth",
      "unpdf",
      "pdf-lib",
    ],
  },
};

export default nextConfig;
