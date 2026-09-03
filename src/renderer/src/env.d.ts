/// <reference types="vite/client" />

import type { MCodeBridge } from "../../preload/index"

declare global {
  interface Window {
    mcode: MCodeBridge
  }
}

declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

export {}
