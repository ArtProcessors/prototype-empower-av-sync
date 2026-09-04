/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Ensure .m4a imports resolve to a URL string even if not in vite/client's
// default list.
declare module '*.m4a' {
  const src: string
  export default src
}
