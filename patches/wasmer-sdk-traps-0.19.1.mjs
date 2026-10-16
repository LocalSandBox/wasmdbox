// Keep WASIX control-flow traps out of the guest's exception handlers. Both
// Function::call and TypedFunction::call use these synchronous apply imports.
export const replacements = {
  'pkg/wasmer_sdk_js.js': [
    ['function __wbg_get_imports(memory) {', 'import { callWithHostTrap, raiseHostTrap } from "../dist/wasmer-host-traps.js";\n\nfunction __wbg_get_imports(memory) {'],
    ['            throw arg0;', '            if (arg0 instanceof Trap) raiseHostTrap(arg0);\n            throw arg0;'],
    ['            const ret = Reflect.apply(arg0, arg1, arg2);', '            const ret = callWithHostTrap(arg0, arg1, arg2);'],
    ['            const ret = arg0.apply(arg1, arg2);', '            const ret = callWithHostTrap(arg0, arg1, arg2);'],
  ],
};
