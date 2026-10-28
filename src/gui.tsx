import { Plugin } from "@opencode/plugin/gui"
import { definition } from "./gui/definition.ts"
import { setup } from "./gui/window.tsx"

export default Plugin.define({ ...definition, setup })
