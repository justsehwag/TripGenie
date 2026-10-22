import { NextResponse } from "next/server";
import { signUp, confirmSignUp, resendCode, signIn, cognitoStatus } from "@/lib/cognito-auth";

export const runtime = "nodejs";

type Body = { action?: string; email?: string; password?: string; name?: string; code?: string };

export async function GET() {
  // Lets the client know if Cognito is wired without exposing any secret.
  return NextResponse.json(cognitoStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try { body = (await request.json()) as Body; } catch { return NextResponse.json({ ok: false, code: "ERROR", message: "Invalid request body." }, { status: 400 }); }
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const code = (body.code ?? "").trim();
  const name = body.name;
  const headers = { "Cache-Control": "no-store" } as const;
  try {
    switch (body.action) {
      case "signup": {
        if (!email || !password) return NextResponse.json({ ok: false, code: "ERROR", message: "Email and password are required." }, { status: 400, headers });
        return NextResponse.json(await signUp(email, password, name), { headers });
      }
      case "confirm": {
        if (!email || !code) return NextResponse.json({ ok: false, code: "ERROR", message: "Email and code are required." }, { status: 400, headers });
        return NextResponse.json(await confirmSignUp(email, code), { headers });
      }
      case "resend": {
        if (!email) return NextResponse.json({ ok: false, code: "ERROR", message: "Email is required." }, { status: 400, headers });
        return NextResponse.json(await resendCode(email), { headers });
      }
      case "signin": {
        if (!email || !password) return NextResponse.json({ ok: false, code: "ERROR", message: "Email and password are required." }, { status: 400, headers });
        return NextResponse.json(await signIn(email, password), { headers });
      }
      default:
        return NextResponse.json({ ok: false, code: "ERROR", message: "Unknown action. Expected signup|confirm|resend|signin." }, { status: 400, headers });
    }
  } catch {
    return NextResponse.json({ ok: false, code: "ERROR", message: "Authentication service error. Please try again." }, { status: 200, headers });
  }
}

