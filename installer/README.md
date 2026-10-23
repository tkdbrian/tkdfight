# TKD Fight Windows Installer

The installer targets Windows 10/11 x64. Tournament operation remains local to the venue network and does not require Internet access after installation.

## Build the installer

1. From the repository root, run `crear-distribucion.bat` on a Windows x64 build machine with Node.js and npm available. This builds the app and prepares `dist-produccion` with production dependencies from `package-lock.json`.
2. Install Inno Setup 6 on the build machine.
3. Run `crear-instalador.bat`. The setup executable is written to `release`.

The portable fallback is named `TKD_Fight_3.0.0.zip`. Do not distribute the older `TKD_Torneo_2026.zip` alongside a new setup; both artifacts must come from the same generated `dist-produccion` folder.

The distribution generator downloads the current x64 Visual C++ Redistributable from Microsoft's official permalink and verifies its Authenticode signature before packaging it. Before redistributing the Microsoft package, confirm that the build/distribution is covered by the applicable Visual Studio license terms: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170

## Runtime requirements

- Windows 10/11 x64.
- The setup installs the bundled x64 Visual C++ Redistributable before installing TKD Fight. The portable asks for administrator approval to install or update it on first launch when the required version is missing.
- The redistributable is included so tournament PCs do not need Internet access, but the build machine needs Internet access while preparing `dist-produccion`.
- For judges and other tournament PCs to connect, allow TCP 3001 on a trusted Private network. The setup requests an elevated install and adds a firewall rule scoped to Private/Domain profiles; it does not open the Public profile.

## Data and uninstall

Program files are installed under `Program Files\TKD Fight`. Tournament databases, ring configuration, and logs are kept under `%ProgramData%\TKD Fight`, separated by role. Updating or uninstalling the program is intended to preserve that folder; back it up before reinstalling Windows or manually removing application data.

Each computer runs its selected role with its own local database. Keep the host and judge devices on the same LAN; guest Wi-Fi client isolation, VLAN separation, VPN routing, or a Windows Public firewall profile can prevent connections.
