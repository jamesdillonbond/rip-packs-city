// lib/alerts/discord-commands.ts
//
// Single source of truth for the Discord slash-command schema. Imported by both
// the interactions endpoint (app/api/bots/discord/route.ts) and the server-side
// registration route (app/api/bots/discord/register/route.ts).
//
// `contexts: [0,1,2]` is what makes the commands usable in DMs:
//   0 = GUILD, 1 = BOT_DM, 2 = PRIVATE_CHANNEL.
// `integration_types` is intentionally left unset — default guild-install is
// correct; Trevor shares a server with the bot so the BOT_DM context resolves.

// Slash-command option types (Discord): 3 = STRING.
export const COMMANDS = [
  {
    name: "link",
    description: "Connect this Discord account to your Rip Packs City account",
    options: [{ name: "code", description: "The code from rippackscity.com/alerts", type: 3, required: true }],
    contexts: [0, 1, 2],
  },
  {
    name: "soldpacks",
    description: "Pack history + P/L for a Flow wallet",
    options: [{ name: "wallet", description: "Flow wallet (0x… 16 hex)", type: 3, required: false }],
    contexts: [0, 1, 2],
  },
  { name: "alerts", description: "Manage your Rip Packs City alerts", contexts: [0, 1, 2] },
];
