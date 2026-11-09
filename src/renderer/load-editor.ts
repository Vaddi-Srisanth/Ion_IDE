type EditorModule = typeof import('./MonacoSurface');

let loaded: EditorModule | undefined;
let modulePromise: Promise<EditorModule> | undefined;

export function loadedEditor() {
  return loaded;
}

export function loadEditor() {
  return (modulePromise ??= import('./MonacoSurface').then((module) => {
    loaded = module;
    return module;
  }).catch((reason: unknown) => {
    modulePromise = undefined;
    throw reason;
  }));
}
