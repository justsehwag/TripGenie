import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TripGenie is a serverless-first Next.js App Router app (Req 19.1).
  // AWS edges (Amplify Hosting + CloudFront) wrap this build; no always-on compute.
  reactStrictMode: true,
};

export default nextConfig;
