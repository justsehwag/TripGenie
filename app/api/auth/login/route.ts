import { createLoginHandler } from "@/lib/auth/oauth-handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createLoginHandler();

export async function GET(request: Request): Promise<Response> {
  return handler(request);
}
