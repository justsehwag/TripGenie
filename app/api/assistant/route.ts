import { createAssistantHandler } from "@/lib/assistant/route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createAssistantHandler();

export async function POST(req: Request): Promise<Response> {
  return handler(req);
}
