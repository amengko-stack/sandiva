/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "docx",
      "@anthropic-ai/sdk",
      "mammoth",
      "unpdf",
      "pdfkit",
    ],
  },
};

export default nextConfig;
