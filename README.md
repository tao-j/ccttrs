# 📷 CCTTRS: Camera Card Transfer & Tracking Recovery System

CCTTRS is a high-performance, lightweight, and cross-platform desktop application designed to streamline media imports for professional photographers and videographers. Built with **Tauri**, **Rust**, **React**, and **TypeScript**, it provides an elegant and lightning-fast solution to offload assets from SD cards and camera storage devices to a host machine.

---

## 🌟 Design Philosophy & Architecture

### 1. Stateless Host Architecture (Self-Contained Card State)
Unlike traditional asset managers that build massive databases on the host computer, CCTTRS is built on a **stateless architecture**. 
- All metadata, target sync configurations, and transfer states are stored directly on the camera card inside a tiny hidden profile file: `.ccttrs.json`.
- **Plug-and-Play**: You can plug a camera card into *any* computer running CCTTRS, and it will immediately identify the drive, resolve its historical transfer state, and know exactly where to stage new files.
- **Portability**: Your cards carry their own sync pointers and histories across multiple workstations without sync database conflicts.

### 2. High-Performance Multithreaded Rust Core
Disk scanning, hardware device listing, directory parsing, and file transfers are handled natively in the Rust background:
- **Responsive Frontend**: UI rendering remains fully responsive at a locked 60+ FPS during heavy operations. Rust processes the copying sequentially on dedicated blocking OS threads, sending light IPC events back to React.
- **Parallel Scanning**: Instantly reads and catalogs thousands of media directories using low-level filesystem descriptors.
- **Background Worker Threads**: Progress, byte calculations, speed metrics, and file listings are updated concurrently on separate worker threads, decoupling visual feedback from I/O block writes.

### 3. Dual-Structure DCIM & Sony XAVC-S Support
Standard camera structures store everything under `/DCIM`. However, modern mirrorless systems (such as Sony Alpha series) store high-quality video files separately (e.g., in `/PRIVATE/M4ROOT/CLIP/` alongside XML metadata).
- CCTTRS includes specialized camera profiles (e.g., **Sony DCIM + PRIVATE** vs. **Generic DCIM-only**) to automatically discover and merge multiple deep media folders into a unified transfer list.

### 4. Glassmorphic Immersive Design
The visual interface of CCTTRS features a premium, state-of-the-art layout designed to feel premium and alive:
- **Curated Palette**: A rich Slate/Charcoal background (`#0f172a`) overlaid with subtle cyan and purple ambient glow gradients.
- **Glassmorphism**: Translucent panels featuring deep backdrop blurs (`12px`) and microscopic translucent borders (`rgba(255, 255, 255, 0.1)`).
- **Smooth Micro-Animations**: Interactive hover effects with soft 3D translations (`translateY(-2px)`), scale physics, and glowing focus borders.
- **Active Progress Bars**: Transfer progress is accompanied by a beautiful flowing animated gradient that pulses according to the sync status.

---

## 🚀 Core Functionalities

*   **Automated Drive Detection**: Hardware-level drive queries (powered by the Rust `sysinfo` crate) auto-detect when a removable drive or SD card is inserted. It displays active storage analytics: volume labels, mount paths, filesystems, and available storage sizes.
*   **Smart Incremental Syncing**: 
    - Scans files, sorts them chronologically by modification time, and filters out files that have already been offloaded (using the pointer in `.ccttrs.json`).
    - Only transfers new shots taken since the last successful sync.
*   **Zero-Overwrite Conflict Resolution**: If a file name collision occurs at the target staging directory:
    - If the file exists and is of the **exact same byte size**, CCTTRS skips it automatically, saving time and reducing SSD wear.
    - If the file has a **different size**, it appends a unique UUID suffix to the filename to preserve both copies safely.
*   **Global Session Override**: Define a global target folder for a shoot, and the app automatically updates all active card stages to point to that directory—ideal for multi-camera multi-card shoots.
*   **Live Transfer Analytics**: Displays high-frequency progress parameters:
    - Real-time disk transfer speed (e.g., `MB/s` or `GB/s`).
    - Total files, files copied, and files skipped.
    - An active, responsive progress bar showing overall byte completion.
    - The path of the file currently being processed.
*   **Safe Drive Ejection**: Once imports are finished, eject the card directly within the UI. CCTTRS invokes platform-native ejection routines to safely unmount:
    - **macOS**: `diskutil unmount` or fallback `diskutil unmountDisk`.
    - **Linux**: Standard safe `umount`.
    - **Windows**: PowerShell automation using standard WMI and Shell COM Eject verbs.

---

## 📂 Project Structure

```
ccttrs/
├── .vscode/                 # Editor configurations
├── src/                     # React + TypeScript Frontend
│   ├── assets/              # App images and logos
│   ├── App.tsx              # Core React logic, drive management, & CardTask components
│   ├── App.css              # Custom HSL design tokens, Glassmorphic styles, & animations
│   └── main.tsx             # React DOM entrypoint
├── src-tauri/               # Rust Backend Core
│   ├── src/
│   │   ├── copy.rs          # Asynchronous syncing engine, folder scanning, & progress calculations
│   │   ├── lib.rs           # Tauri command routing, AppState, and initialization
│   │   ├── main.rs          # Main Rust executable entrypoint
│   │   ├── state.rs         # SD Card Profile structures (.ccttrs.json serialization)
│   │   └── sys.rs           # OS-specific device listing & safe volume ejection logic
│   ├── capabilities/        # Tauri client permissions
│   ├── gen/                 # Auto-generated schemas & icons
│   ├── Cargo.toml           # Rust dependencies
│   └── tauri.conf.json      # Tauri application configuration
├── package.json             # Node dependencies and build scripts
└── tsconfig.json            # TypeScript configuration
```

---

## 🛠️ Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [Rust & Cargo](https://www.rust-lang.org/tools/install) (via `rustup`)
- Build essentials specific to your OS (Tauri will automatically prompt if missing)

### Development Setup

1.  **Clone the Repository** and navigate to the project directory.
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Run the application in development mode**:
    ```bash
    npm run tauri dev
    ```
    This launches a hot-reloaded development window displaying the web app backed by a live compilation of the Rust core.

### Production Compiles

To compile the production-ready optimized native installer:
```bash
npm run tauri build
```
This generates standard installer packages (`.dmg` for macOS, `.msi` or `.exe` for Windows, `.deb` or `.appimage` for Linux) inside the `src-tauri/target/release/bundle/` directory.

---

## 🛡️ License

Private / Proprietary. Developed for secure, standalone camera offloads.
