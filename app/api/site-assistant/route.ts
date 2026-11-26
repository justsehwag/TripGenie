import { createSiteAssistantHandler } from "@/lib/site-assistant/route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createSiteAssistantHandler();

export async function POST(req: Request): Promise<Response> {
  return handler(req);
}
