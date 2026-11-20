import { createAuthHandlers } from "@/lib/auth/auth-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAuthHandlers();

export async function GET(request: Request): Promise<Response> {
  return handlers.sessionGET(request);
}
