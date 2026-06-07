/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["docx", "@anthropic-ai/sdk"],
  },
};

export default nextConfig;
