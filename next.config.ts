import type { NextConfig } from "next";

// Amplify Hosting does NOT pass console/branch env vars to the Next.js SSR
// runtime Lambda - only to the BUILD step. So we read them here (at build time,
// where Amplify DOES populate process.env) and inline them into the server
// bundle via `env`, making process.env.* resolve at request time in the Lambda.
// See AWS docs: Making environment variables accessible to server-side runtimes.
//
// Only NON-SECRET identifiers belong here. The Cognito app client has no secret;
// user-pool id / client id are safe to inline. Never add a real secret below.
const passthrough = [
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_REGION",
  "BEDROCK_MODEL_ID",
  "BEDROCK_REGION",
] as const;

const bakedEnv: Record<string, string> = {};
for (const key of passthrough) {
  const v = process.env[key];
  if (v && v.trim()) bakedEnv[key] = v.trim();
}

const nextConfig: NextConfig = {
  // TripGenie is a serverless-first Next.js App Router app (Req 19.1).
  // AWS edges (Amplify Hosting + CloudFront) wrap this build; no always-on compute.
  reactStrictMode: true,
  env: bakedEnv,
};

export default nextConfig;