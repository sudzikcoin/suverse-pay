/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard sits behind suverse-pay.suverse.io once deployed.
  // Trust the X-Forwarded-Proto header so NextAuth's redirect URIs
  // resolve to https:// in production.
  experimental: {
    serverActions: { allowedOrigins: ["suverse-pay.suverse.io", "localhost:3002"] },
  },
};

export default nextConfig;
