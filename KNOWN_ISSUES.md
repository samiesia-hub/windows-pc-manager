# 🛠️ Known Issues & Future Improvements

This document tracks technical limitations, "simulated" features, and security considerations that were acknowledged during development but not fully implemented in the current version.

## 🔒 Security Considerations
*   **Remote Access Authentication:** The Remote Control feature currently uses a public WebSocket endpoint. There is **no password or token-based authentication**. Anyone on the same local network who knows your IP and Port can control your mouse.
    *   *Improvement:* Implement a pairing token or PIN system in `lib.rs`.
*   **Administrator Privileges:** Features like `powercfg` (Profiles) and `taskkill` (Game Mode) require the app to be run as **Administrator**. The app does not currently auto-elevate or prompt for UAC.

## ⚠️ Known Bugs & Limitations
*   **GPU Detection:** In some environments, the GPU name may show as "Unknown" if the PowerShell CIM instance command fails or is blocked by system policy.
*   **System Update Logic:** The "System Updater" tab currently runs a **simulated sequence**. It does not interface with the Windows Update Agent (WUA) API to actually download and install OS patches.
*   **Security Scanning:** The "Quick Scan" in the Security tab triggers a UI simulation. While it provides notifications and mock threat removal, it does not perform a deep heuristic scan of the file system.
*   **Focus Mode Persistence:** "Minimize All" is a one-time action. The app does not currently force windows to stay minimized or suppress incoming Windows system toasts (Do Not Disturb).
*   **Game Mode Scope:** The list of apps to stop is currently limited to a few hardcoded distraction apps (Chrome, Discord, etc.). It does not dynamically identify high-memory background processes.

## 🛠️ Technical Debt
*   **Icon Assets:** The current `icon-source.png` may require manual conversion to a valid PNG format before `npm run tauri build` will accept it for icon generation.
*   **Error Handling:** Some backend commands (like `apply_performance_profile`) assume the standard Windows Power GUIDs exist. On highly customized Windows "Lite" versions, these GUIDs might be missing.
*   **Dynamic UI:** The Remote Control QR code relies on a local IP fetch that may fail if there are multiple virtual network adapters (Docker, VPNs).

## 🚀 Future Roadmap
*   [ ] Add AES-256 encryption/pairing for Remote Control.
*   [ ] Integrate real `Win32_Process` API for deeper task management.
*   [ ] Implement real registry-based "Deep Clean" for leftovers.
*   [ ] Add customizable "Workflows" for Profiles (e.g., open specific apps when entering "Work Mode").
