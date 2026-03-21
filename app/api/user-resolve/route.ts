import { NextRequest, NextResponse } from "next/server";
import { topshotGraphql } from "@/lib/topshot";

function isWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(value.trim());
}

type ResolveResponse = {
  input: string;
  inputType: "wallet" | "username";
  walletAddress: string | null;
  username: string | null;
  dapperId: string | null;
};

type TopShotUserProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: {
      flowAddress?: string | null;
      username?: string | null;
      dapperID?: string | null;
    } | null;
  } | null;
};

async function tryResolveUsername(username: string) {
  const query = `
    query ResolveUserByUsername($username: String!) {
      getUserProfileByUsername(username: $username) {
        publicInfo {
          flowAddress
          username
          dapperID
        }
      }
    }
  `;

  const data = await topshotGraphql<TopShotUserProfileResponse>(query, {
    username,
  });

  return data.getUserProfileByUsername?.publicInfo ?? null;
}

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

    const cleanedUsername = rawInput.replace(/^@+/, "").trim();

    let publicInfo = await tryResolveUsername(cleanedUsername);

    if (!publicInfo?.flowAddress && cleanedUsername.toLowerCase() !== cleanedUsername) {
      publicInfo = await tryResolveUsername(cleanedUsername.toLowerCase());
    }

    console.log("[USER_RESOLVE_DEBUG]", {
      input: rawInput,
      cleanedUsername,
      publicInfo,
    });

    if (!publicInfo?.flowAddress) {
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
      walletAddress: publicInfo.flowAddress ?? null,
      username: publicInfo.username ?? cleanedUsername,
      dapperId: publicInfo.dapperID ?? null,
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