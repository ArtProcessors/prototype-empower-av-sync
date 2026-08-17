/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Ensure .m4a imports resolve to a URL string even if not in vite/client's
// default list.
declare module '*.m4a' {
  const src: string
  export default src
}

interface ImportMetaEnv {
  /** Trystero matchmaking backend: `nostr` (default), `mqtt` or `torrent`. */
  readonly VITE_TRYSTERO_STRATEGY?: string
  /** Comma-separated Nostr relay URLs overriding Trystero's defaults. */
  readonly VITE_NOSTR_RELAYS?: string
  /** TURN server URL, for networks that block direct peer connections. */
  readonly VITE_TURN_URL?: string
  /** Username for {@link ImportMetaEnv.VITE_TURN_URL}. */
  readonly VITE_TURN_USERNAME?: string
  /** Credential for {@link ImportMetaEnv.VITE_TURN_URL}. */
  readonly VITE_TURN_CREDENTIAL?: string
}

interface ImportMeta {
  /** Build-time environment variables; see {@link ImportMetaEnv}. */
  readonly env: ImportMetaEnv
}
