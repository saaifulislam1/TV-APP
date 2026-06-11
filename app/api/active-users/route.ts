import { NextResponse } from "next/server";

const ACTIVE_WINDOW_MS = 45_000;

type ActiveUsersRequest = {
  sessionId?: unknown;
  action?: unknown;
};

const globalForActiveUsers = globalThis as typeof globalThis & {
  __tvAppActiveSessions?: Map<string, number>;
};

const activeSessions =
  globalForActiveUsers.__tvAppActiveSessions ??
  new Map<string, number>();

globalForActiveUsers.__tvAppActiveSessions = activeSessions;

export const dynamic = "force-dynamic";

const pruneInactiveSessions = (now: number) => {
  for (const [sessionId, lastSeen] of activeSessions) {
    if (now - lastSeen > ACTIVE_WINDOW_MS) {
      activeSessions.delete(sessionId);
    }
  }
};

const json = () =>
  NextResponse.json(
    { activeUsers: activeSessions.size },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );

export async function GET() {
  pruneInactiveSessions(Date.now());
  return json();
}

export async function POST(request: Request) {
  const now = Date.now();
  const payload = (await request.json().catch(() => ({}))) as ActiveUsersRequest;
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";

  pruneInactiveSessions(now);

  if (sessionId) {
    if (payload.action === "leave") {
      activeSessions.delete(sessionId);
    } else {
      activeSessions.set(sessionId, now);
    }
  }

  return json();
}
