# Windows prerequisites

The x64 installer bundles the IDE, Electron, and the workspace search tool. A working desktop is enough to open and edit source files and use offline lessons and previews.

| Workflow | Local prerequisite | Check in PowerShell |
| --- | --- | --- |
| C and C++ | x64 GCC and G++ from a MinGW-w64 distribution, or Clang and Clang++ with a configured linker and standard library. Put the toolchain’s `bin` folder on `PATH`. | `gcc --version` and `g++ --version`, or `clang --version` and `clang++ --version` |
| Java | JDK with both `java.exe` and `javac.exe`. Set `JAVA_HOME` to the JDK directory or add its `bin` folder to `PATH`. | `java -version` and `javac -version` |
| Maven and Gradle projects | Apache Maven 3.9.x or Gradle 8.10 through 9.x, with the required plugins and dependencies already cached. Set `MAVEN_HOME` or `GRADLE_HOME` to the installed distribution, or add its actual `bin` to `PATH`. | `mvn --version` or `gradle --version` |
| Python | Installed Python 3 with its executable on `PATH`. | `python --version` |
| JavaScript | Node.js with its executable on `PATH`. | `node --version` |
| Run Jupyter cells | A local Python environment with `jupyter_client` and `ipykernel`. Select it through **Kernel** in the notebook tab. | `python -m pip show jupyter_client ipykernel` |
| View PPTX slides | A Windows desktop application associated with `.pptx`. | Open a `.pptx` from File Explorer. |

For source builds, see the [Windows build guide](BUILD.md).

Ion asks before running project builds. It bypasses wrapper and shim scripts on Windows. Offline flags prevent Maven and Gradle from resolving missing dependencies over the network. Reviewed project code or plugins still run with your permissions. Localized paths depend on the installed toolchain and its Windows character encoding. [Compatibility audit](../../WINDOWS_COMPATIBILITY_AUDIT.md)
