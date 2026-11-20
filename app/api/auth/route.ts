import { createAuthHandlers } from "@/lib/auth/auth-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAuthHandlers();

export async function GET(): Promise<Response> {
  return handlers.GET();
}

export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
