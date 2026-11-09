const platformTypes = [
  ['Plain Text', 'public.plain-text'],
  ['Java Source', 'com.sun.java-source'],
  ['C Source', 'public.c-source'],
  ['C Header', 'public.c-header'],
  ['Python Source', 'public.python-script'],
  ['C++ Source', 'public.c-plus-plus-source'],
  ['C++ Header', 'public.c-plus-plus-header'],
  ['JavaScript Source', 'com.netscape.javascript-source'],
  ['JSON', 'public.json'],
  ['Markdown', 'net.daringfireball.markdown'],
  ['CSS Stylesheet', 'public.css'],
  ['Shell Script', 'public.shell-script'],
  ['Bash Script', 'public.bash-script'],
  ['Zsh Script', 'public.zsh-script'],
  ['YAML', 'public.yaml'],
]

// Give extensions without a platform type a stable document identifier.
const importedTypes = [
  ['Jupyter Notebook', 'dev.ionide.jupyter-notebook', 'ipynb', 'public.json'],
  ['Python Source', 'dev.ionide.python-source', 'python', 'public.python-script'],
  ['CommonJS Source', 'dev.ionide.commonjs-source', 'cjs', 'com.netscape.javascript-source'],
  ['JSX Source', 'dev.ionide.jsx-source', 'jsx', 'com.netscape.javascript-source'],
  ['TSX Source', 'dev.ionide.tsx-source', 'tsx', 'public.source-code'],
]

export const macDocumentInfo = {
  CFBundleDocumentTypes: [...platformTypes, ...importedTypes].map(([name, identifier]) => ({
    CFBundleTypeName: name,
    CFBundleTypeRole: 'Editor',
    LSHandlerRank: 'Alternate',
    LSItemContentTypes: [identifier],
  })),
  UTImportedTypeDeclarations: importedTypes.map(([name, identifier, extension, parent]) => ({
    UTTypeIdentifier: identifier,
    UTTypeDescription: name,
    UTTypeConformsTo: [parent],
    UTTypeTagSpecification: { 'public.filename-extension': [extension] },
  })),
}
