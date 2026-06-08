/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "docx",
      "@anthropic-ai/sdk",
      "mammoth",
    ],
  },
};

export default nextConfig;
