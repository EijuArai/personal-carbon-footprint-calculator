import { autoDiscover, createClient } from "@solana/client";

const endpoint = import.meta.env.VITE_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const websocketEndpoint =
  import.meta.env.VITE_SOLANA_WS_URL ?? endpoint.replace("https://", "wss://").replace("http://", "ws://");

export const solanaClient = createClient({
  endpoint,
  websocketEndpoint,
  walletConnectors: autoDiscover(),
});