// app/api/user-resolve/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  isWalletAddress,
  resolveTopShotUsername,
} from "@/lib/topshot-username-resolve";

type ResolveResponse = {
  input: string;
  inputType: "wallet" | "username";
  walletAddress: string | null;
  username: string | null;
  dapperId: string | null;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { input?: string };
    const rawInput = (body.input ?? "").trim();

    if (!rawInput) {
      return NextResponse.json(
        { error: "Please enter a wallet or username." },
        { status: 400 }
      );
    }

    if (isWalletAddress(rawInput)) {
      const result: ResolveResponse = {
        input: rawInput,
        inputType: "wallet",
        walletAddress: rawInput,
        username: null,
        dapperId: null,
      };
      return NextResponse.json(result);
    }

    const resolved = await resolveTopShotUsername(rawInput);

    if (!resolved) {
      return NextResponse.json(
        {
          error:
            "I could not resolve that Top Shot username yet. Try removing @, and if it still fails send me the USER_RESOLVE_DEBUG log from your terminal.",
        },
        { status: 404 }
      );
    }

    const result: ResolveResponse = {
      input: rawInput,
      inputType: "username",
      walletAddress: resolved.walletAddress,
      username: resolved.username,
      dapperId: resolved.dapperId,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("[USER_RESOLVE_ERROR]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Username resolution failed.",
      },
      { status: 500 }
    );
  }
}
