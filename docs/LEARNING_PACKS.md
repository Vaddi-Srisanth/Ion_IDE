# Learning packs

Open the storefront icon to browse Marketplace, search for a topic, filter by category or difficulty, and install a bundled pack. Select an installed pack in Learn to open its topic index. Use **Update** for a newer bundled pack and **Export** to save a portable copy. Import a local JSON file, review its author, license, version, and topic list, then confirm the installation. Lessons, examples, exercises, and saved Practice attempts work offline. The **Online references** section opens the system browser only when you select a reference.

A pack’s **Diagnostics** badge means Ion recognizes a reviewed subset of output from a matching toolchain. Ion supports specific patterns from GCC or Clang for C and C++, javac and the Java runtime, CPython, and Node.js. It shows the original output and abstains when it cannot reliably map a message. Diagnostic guidance appears when Learn is open and the selected pack matches the program’s language.

Lesson exercises include a prompt, expected behavior, completion criteria, and optional sample input and output. For the bundled C, C++, Java, Python, and JavaScript packs, **Open in Practice** uses Ion’s existing Practice workspace and opens a starter file. Solve the exercise there and run the samples yourself. Ion resumes the latest saved attempt by pack and lesson ID. Updating or removing the pack leaves the Practice record and diagnostic history intact. Sample inputs and outputs are data and only exercise a solution when you explicitly run it.

## Pack file format

An exchange file is a UTF-8 JSON object of up to **256 KiB**. Ion accepts both schema 1 and schema 2. Use schema 2 for new work. Its individual lessons may use up to 48 KiB each. A pack ID uses up to 40 lowercase letters, digits, and hyphen-separated groups. Give it a stable, distinctive ID. Bundled IDs and reserved filesystem names are unavailable for new local imports.

| Field | Meaning |
| --- | --- |
| `schema` | Format revision. Use `2`. |
| `id`, `name`, `summary` | Stable identifier, display title, and short catalog description. |
| `version` | Positive integer revision of this pack. Increase it for an update. |
| `metadata.kind` | One of `language`, `markup`, `stylesheet`, `query`, `data-format`, or `framework`. |
| `metadata.categories` | One or more of `core`, `web`, `automation`, `data`, and `systems`. |
| `metadata.languageVersion` | The language, standard, or tool version the examples target. State the dialect for SQL and assembly. |
| `metadata.prerequisites`, `metadata.miniProject` | Prior knowledge or tools needed, and a small project the student can build independently. |
| `metadata.references` | One or more objects with a `title` and an HTTPS `url`. References are links, not embedded content. |
| `metadata.attribution` | An `author` and `license`. Specify terms that apply to the material you have rights to share. |
| `metadata.minimumIonVersion` | Optional numeric `major.minor.patch` compatibility requirement in addition to schema support. |
| `lessons` | Ordered list of 1–64 lesson records. The desktop build derives the lesson count, byte size, and search index. |

Each lesson requires `id`, `title`, `section`, `explanation`, `example`, `api` (an array of `{ "name", "description" }`), and `practice`. Use `difficulty` with `beginner`, `intermediate`, or `advanced`. Add `prerequisites` with IDs of earlier lessons and `related` with other IDs in the same pack. Short `keywords` improve local search. Add a `pitfall` where it addresses a mistake a student is likely to make.

Use `exampleFile` for a filename with an extension and `exampleMode` with `program` for a runnable example or `fragment` for a snippet that needs context. State expected text in `expectedOutput` when appropriate. The application displays code as text. Optional lesson `references` use the same HTTPS format as pack references. Optional `exercise` has `expected`, `completion`, and at most eight `samples` with `input` and `expectedOutput`. Start with the bundled [Python pack](../src/main/learning/catalog/python.json) for a complete example.

## Verify and update

1. Run each complete example with the tool and version you state. Compare stdout or the rendered result with the lesson. Label fragments clearly and test them in their intended context.
2. Check lesson prerequisites, edge cases, and references. Original explanations and examples are easier to maintain and attribute.
3. Keep existing lesson IDs when releasing a higher pack version. Use a separate pack ID for incompatible material. An update that drops an existing lesson ID is rejected.
4. Preview, install, open a lesson, and export the pack from Marketplace. An import must match the content that was reviewed. An existing bundled pack cannot be replaced by an import.
5. For bundled contributions, put the source JSON in `src/main/learning/catalog/<id>.json` and run `npm test -- learning-packs` and `npm run build`. The build validates each file and writes the catalog and per-pack detail indexes. Use `npm run test:marketplace` for the desktop flow.

Run the bundled-example verifier with the matching local toolchains installed.

```sh
node scripts/verify-learning-examples.mjs c cpp java python javascript typescript json xml yaml sql
```

New installations keep a separate topic index and one file per lesson in the local profile. Older flat installs remain readable. On update, Ion finishes writing the new pack before switching its library entry. Import parsing runs in the desktop main process, and pack text and code render as text. Unknown fields, unsafe reference URLs, oversized files, and unsupported schema versions are rejected. Pack files contain no install hooks or remote resources.

## Catalog roadmap

The six core packs have 15 lessons each. Go, Rust, HTML, and CSS still use the shorter original packs. Kotlin, PHP, GraphQL, PowerShell, Lua, R, Julia, MATLAB/Octave, Zig, Dart, Scala, Haskell, Elixir, and assembly fundamentals remain candidates for future batches. The Marketplace lists packs when their material is ready for use.
