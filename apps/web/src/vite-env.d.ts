/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Merchant base URL for Live mode. Unset means Live is disabled. */
  readonly VITE_MERCHANT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
