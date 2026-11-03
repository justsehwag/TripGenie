import type { NextConfig } from "next";

// Amplify Hosting does NOT pass console/branch env vars to the Next.js SSR
// runtime Lambda - only to the BUILD step. So we read them here (at build time,
// where Amplify DOES populate process.env) and inline them into the server
// bundle via `env`, making process.env.* resolve at request time in the Lambda.
// See AWS docs: Making environment variables accessible to server-side runtimes.
//
// Non-secret identifiers (Cognito ids) AND server-only provider secrets
// (SerpApi / Google Places keys) are inlined here. The provider secrets are
// read ONLY by server-side code and are never imported by a "use client"
// module, so Next keeps them in the server bundle and they never ship to the
// browser. Do NOT add any value that a client component imports.
const passthrough = [
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_REGION",
  "BEDROCK_MODEL_ID",
  "BEDROCK_REGION",
  // Server-only provider keys. These are read ONLY by server-side modules
  // (lib/config.ts serpApiKey/googlePlacesApiKey, invoked from server routes
  // and server adapters) and are NEVER imported by a "use client" module, so
  // Next keeps them in the server bundle and they do not reach the browser.
  // Amplify only populates these at build time, so they must be inlined here
  // to resolve at request time in the SSR Lambda (same mechanism as above).
  "SERPAPI_API_KEY",
  "SERPAPI_MONTHLY_SOFT_LIMIT",
  "GOOGLE_PLACES_API_KEY",
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