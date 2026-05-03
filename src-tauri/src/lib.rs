use serde::{Serialize, Deserialize};
use std::process::{Command, Stdio};
use sysinfo::{System, Networks, Components, Disks};
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;

use local_ip_address::local_ip;
use tauri::{Emitter, Window, Manager};
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;

#[derive(Serialize, Deserialize)]
pub struct SystemStats {
    cpu_usage: f32,
    ram_used: u64,
    ram_total: u64,
    disks: Vec<DiskInfo>,
    net_rx: u64,
    net_tx: u64,
    gpu_name: String,
    cpu_temp: f32,
    battery_level: i32,
    is_charging: bool,
    uptime: u64,
}

#[derive(Serialize, Deserialize)]
pub struct DiskInfo {
    name: String,
    free_space: u64,
    total_space: u64,
}

#[derive(Serialize, Deserialize)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    memory: u64,
    cpu_usage: f32,
}

#[derive(Serialize, Deserialize)]
pub struct AppInfo {
    name: String,
    id: String,
    version: String,
    available_version: Option<String>,
    /// The raw UninstallString from registry (for running the real uninstaller)
    uninstall_cmd: Option<String>,
    install_location: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub theme: String,
    pub start_on_boot: bool,
    pub server_port: u16,
    pub show_ip: bool,
    pub refresh_interval: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            start_on_boot: false,
            server_port: 4040,
            show_ip: true,
            refresh_interval: 2000,
        }
    }
}

pub struct AppState {
    pub sys: Mutex<System>,
    pub networks: Mutex<Networks>,
    pub prev_net: Mutex<(u64, u64)>,
    pub gpu_name: String,
    pub active_remote_connections: std::sync::Arc<std::sync::atomic::AtomicU32>,
    pub config: Mutex<AppConfig>,
    pub server_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

fn get_config_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = app_handle.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path.join("config.json")
}

fn load_config(app_handle: &tauri::AppHandle) -> AppConfig {
    let path = get_config_path(app_handle);
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str(&content) {
                return config;
            }
        }
    }
    AppConfig::default()
}

fn save_config_to_disk(app_handle: &tauri::AppHandle, config: &AppConfig) {
    let path = get_config_path(app_handle);
    if let Ok(content) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, content);
    }
}

fn set_autostart(enabled: bool) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let (key, _) = hkcu.create_subkey(path).map_err(|e| e.to_string())?;

    if enabled {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value("PCManager", &current_exe.to_str().unwrap()).map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("PCManager");
    }
    Ok(())
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn update_config(
    app_handle: tauri::AppHandle,
    state: tauri::State<AppState>,
    new_config: AppConfig,
) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    
    // Handle autostart change
    if config.start_on_boot != new_config.start_on_boot {
        set_autostart(new_config.start_on_boot)?;
    }

    *config = new_config;
    save_config_to_disk(&app_handle, &config);
    Ok(())
}

#[tauri::command]
fn get_system_stats(state: tauri::State<AppState>) -> SystemStats {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    
    let cpu_usage = sys.global_cpu_usage();
    let ram_used = sys.used_memory();
    let ram_total = sys.total_memory();

    // Simplified Network: Always use manual delta for maximum reliability on Windows
    let mut networks = state.networks.lock().unwrap();
    networks.refresh(false);

    let mut total_rx_cum: u64 = 0;
    let mut total_tx_cum: u64 = 0;
    for (_name, data) in networks.iter() {
        total_rx_cum += data.total_received();
        total_tx_cum += data.total_transmitted();
    }
    
    let mut prev = state.prev_net.lock().unwrap();
    // On the very first run, we return 0 so we don't get a massive spike
    let net_rx = if prev.0 == 0 { 0 } else { total_rx_cum.saturating_sub(prev.0) };
    let net_tx = if prev.1 == 0 { 0 } else { total_tx_cum.saturating_sub(prev.1) };
    *prev = (total_rx_cum, total_tx_cum);

    let disks_obj = Disks::new_with_refreshed_list();
    let mut disks = Vec::new();
    for disk in &disks_obj {
        disks.push(DiskInfo {
            name: disk.mount_point().to_string_lossy().to_string(),
            free_space: disk.available_space(),
            total_space: disk.total_space(),
        });
    }

    // Broadened Temp Search: Try any available sensor if CPU specific isn't found
    let mut cpu_temp = 0.0;
    let components = Components::new_with_refreshed_list();
    for component in &components {
        let val = component.temperature().unwrap_or(0.0);
        if val > 0.0 {
            cpu_temp = val;
            break; 
        }
    }

    if cpu_temp == 0.0 {
        // Fallback to WMI
        let temp_script = "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -ExpandProperty CurrentTemperature";
        if let Ok(output) = Command::new("powershell").args(&["-NoProfile", "-Command", temp_script]).creation_flags(0x08000000).output() {
            if let Ok(temp_raw) = String::from_utf8_lossy(&output.stdout).trim().parse::<f32>() {
                cpu_temp = (temp_raw / 10.0) - 273.15;
            }
        }
    }

    if cpu_temp == 0.0 {
        let temp_script = "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -ExpandProperty CurrentTemperature";
        if let Ok(output) = Command::new("powershell").args(&["-NoProfile", "-Command", temp_script]).creation_flags(0x08000000).output() {
            if let Ok(temp_raw) = String::from_utf8_lossy(&output.stdout).trim().parse::<f32>() {
                cpu_temp = (temp_raw / 10.0) - 273.15;
            }
        }
    }

    // Get Battery Info
    let mut battery_level = 100;
    let mut is_charging = false;
    let batt_script = "Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json";
    if let Ok(output) = Command::new("powershell").args(&["-NoProfile", "-Command", batt_script]).creation_flags(0x08000000).output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
            battery_level = json["EstimatedChargeRemaining"].as_i64().unwrap_or(100) as i32;
            is_charging = json["BatteryStatus"].as_i64().unwrap_or(0) == 2;
        }
    }

    let uptime = sysinfo::System::uptime();

    SystemStats { 
        cpu_usage, 
        ram_used, 
        ram_total, 
        disks,
        net_rx,
        net_tx,
        gpu_name: state.gpu_name.clone(),
        cpu_temp,
        battery_level,
        is_charging,
        uptime,
    }
}

#[tauri::command]
fn get_processes(state: tauri::State<AppState>) -> Vec<ProcessInfo> {
    let mut sys = state.sys.lock().unwrap();
    // sys.refresh_processes() in sysinfo 0.30+ requires ProcessesToUpdate
    // We will just refresh all processes which is safe
    sys.refresh_all();
    
    let mut procs = Vec::new();
    for (pid, process) in sys.processes() {
        procs.push(ProcessInfo {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().to_string(),
            memory: process.memory(),
            cpu_usage: process.cpu_usage(),
        });
    }
    procs.sort_by(|a, b| b.memory.cmp(&a.memory));
    procs.truncate(200);
    procs
}

#[tauri::command]
fn kill_process(pid: u32, state: tauri::State<AppState>) -> Result<String, String> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_all();
    if let Some(process) = sys.process(sysinfo::Pid::from_u32(pid)) {
        if process.kill() {
            Ok(format!("Process {} killed successfully", pid))
        } else {
            Err(format!("Failed to kill process {}", pid))
        }
    } else {
        Err(format!("Process {} not found", pid))
    }
}

#[tauri::command]
fn get_installed_apps() -> Vec<AppInfo> {
    // Read all three Uninstall registry hives and gather DisplayName + DisplayVersion + UninstallString
    let script = r#"
        $paths = @(
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        $apps = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_.DisplayName) } |
            Select-Object DisplayName, DisplayVersion, UninstallString, InstallLocation, DisplayIcon |
            Sort-Object DisplayName
        ConvertTo-Json -InputObject @($apps) -Compress
    "#;

    let output = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        .args(&["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    let mut apps = Vec::new();
    if let Ok(out) = output {
        let stdout = String::from_utf8_lossy(&out.stdout);
        if let Ok(json_apps) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
            for (index, app) in json_apps.iter().enumerate() {
                if let Some(name) = app.get("DisplayName").and_then(|n| n.as_str()) {
                    let version = app.get("DisplayVersion").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let uninstall_cmd = app.get("UninstallString").and_then(|u| u.as_str()).map(|s| s.to_string());
                    let mut install_location = app.get("InstallLocation").and_then(|i| i.as_str()).map(|s| s.to_string());
                    let display_icon = app.get("DisplayIcon").and_then(|i| i.as_str()).map(|s| s.to_string());

                    // TRUTH SOURCE 1: Use DisplayIcon if it exists (it's the most likely to be correct for moved apps)
                    if let Some(icon_path) = &display_icon {
                        let path_str = icon_path.split(',').next().unwrap_or(icon_path).trim_matches(|c| c == '"' || c == '\'');
                        if !path_str.is_empty() {
                            let path = std::path::Path::new(path_str);
                            if let Some(parent) = path.parent() {
                                if parent.exists() && parent.to_string_lossy().len() > 3 {
                                    install_location = Some(parent.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                    
                    // FALLBACK 2: If still no good location, try to parse from UninstallString
                    if install_location.as_ref().map_or(true, |l| l.trim().is_empty() || !std::path::Path::new(l).exists()) {
                        if let Some(cmd) = &uninstall_cmd {
                            let path_str = cmd.trim_matches(|c| c == '"' || c == '\'');
                            if path_str.get(1..3) == Some(":\\") {
                                let path = std::path::Path::new(path_str);
                                if let Some(parent) = path.parent() {
                                    let parent_str = parent.to_string_lossy().to_string();
                                    if parent.exists() && parent_str.len() > 3 {
                                        install_location = Some(parent_str);
                                    }
                                }
                            }
                        }
                    }

                    // FALLBACK 3: Scan Program Files for a folder name match
                    if install_location.as_ref().map_or(true, |l| l.trim().is_empty() || !std::path::Path::new(l).exists()) {
                        let common_paths = vec!["C:\\Program Files", "C:\\Program Files (x86)"];
                        for base_path in common_paths {
                            if let Ok(entries) = std::fs::read_dir(base_path) {
                                for entry in entries.flatten() {
                                    if let Ok(file_name) = entry.file_name().into_string() {
                                        if name.to_lowercase().contains(&file_name.to_lowercase()) || 
                                           file_name.to_lowercase().contains(&name.to_lowercase()) {
                                            install_location = Some(entry.path().to_string_lossy().to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                            if install_location.is_some() { break; }
                        }
                    }

                    apps.push(AppInfo {
                        name: name.to_string(),
                        id: format!("app_{}", index),
                        version: version.to_string(),
                        available_version: None,
                        uninstall_cmd,
                        install_location,
                    });
                }
            }
        }
    }
    apps
}


#[derive(Serialize, Deserialize, Clone)]
pub struct BackupInfo {
    name: String,
    app_name: String,
    path: String,
    size_bytes: u64,
    created_at: String,
}

fn zip_dir_recursive(
    zip: &mut zip::ZipWriter<fs::File>,
    base: &std::path::Path,
    current: &std::path::Path,
    options: zip::write::FileOptions<()>,
) -> std::io::Result<()> {
    use std::io::Write;
    let entries = match fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return Ok(()), // Ignore inaccessible folders
    };

    for entry in entries.flatten() {
        let path = entry.path();
        // Skip symlinks to prevent infinite loops
        if path.is_symlink() {
            continue;
        }

        let rel = path.strip_prefix(base).unwrap_or(&path);
        let zip_name = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            let _ = zip.add_directory(&zip_name, options);
            let _ = zip_dir_recursive(zip, base, &path, options);
        } else if path.is_file() {
            if let Ok(mut f) = fs::File::open(&path) {
                let _ = zip.start_file(&zip_name, options);
                let mut buf = Vec::new();
                let _ = std::io::Read::read_to_end(&mut f, &mut buf);
                let _ = zip.write_all(&buf);
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn backup_app_data(name: String, window: tauri::Window) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let backup_dir = home.join("Desktop").join("PCManager_Backups");
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    let search_paths = vec![
        home.join("AppData").join("Roaming"),
        home.join("AppData").join("Local"),
        home.join("AppData").join("LocalLow"),
        PathBuf::from("C:\\ProgramData"),
        PathBuf::from("C:\\Program Files"),
        PathBuf::from("C:\\Program Files (x86)"),
    ];

    let name_lower = name.to_lowercase();
    let mut found_paths: Vec<PathBuf> = Vec::new();

    for base in &search_paths {
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.to_string_lossy().to_lowercase().contains(&name_lower) {
                    found_paths.push(path);
                }
            }
        }
    }

    let _ = window.emit("uninstall-progress", format!("🗂️ Found {} folder(s) to backup for '{}'", found_paths.len(), name));

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let zip_name = format!("{}_{}.zip", name.replace(' ', "_"), timestamp);
    let zip_path = backup_dir.join(&zip_name);
    let file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Stored); // Use Stored to avoid huge CPU overhead / hangs for big apps

    if found_paths.is_empty() {
        let _ = zip.start_file("backup_manifest.txt", options);
        use std::io::Write;
        let _ = zip.write_all(
            format!("App: {}\nTimestamp: {}\nNo data folders found.\n", name, timestamp).as_bytes()
        );
    } else {
        for folder_path in &found_paths {
            let _ = window.emit("uninstall-progress", format!("📦 Backing up: {}", folder_path.display()));
            if folder_path.is_dir() {
                let folder_name = folder_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let _ = zip.add_directory(&folder_name, options);
                let _ = zip_dir_recursive(&mut zip, folder_path, folder_path, options);
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    let zip_size = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    let _ = window.emit("uninstall-progress", format!("✅ Backup saved: {} ({:.1} KB)", zip_name, zip_size as f64 / 1024.0));
    Ok(format!("Backup created: {}", zip_path.display()))
}

#[tauri::command]
fn list_backups() -> Vec<BackupInfo> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    let backup_dir = home.join("Desktop").join("PCManager_Backups");
    let mut backups = Vec::new();

    if let Ok(entries) = fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("zip") {
                let file_name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let (app_name, created_at) = if let Some(pos) = file_name.rfind('_') {
                    let ts_str = &file_name[pos+1..];
                    let ts: u64 = ts_str.parse().unwrap_or(0);
                    let app = file_name[..pos].replace('_', " ");
                    (app, ts.to_string())
                } else {
                    (file_name.clone(), "0".to_string())
                };
                backups.push(BackupInfo {
                    name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    app_name,
                    path: path.to_string_lossy().to_string(),
                    size_bytes,
                    created_at,
                });
            }
        }
    }

    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    backups
}

#[tauri::command]
async fn delete_backup(backup_path: String) -> Result<(), String> {
    fs::remove_file(&backup_path).map_err(|e| format!("Failed to delete backup: {}", e))
}

#[tauri::command]
async fn restore_backup(backup_path: String, window: tauri::Window) -> Result<(), String> {
    use std::io::Read;
    let _ = window.emit("uninstall-progress", format!("🔄 Opening backup: {}", backup_path));
    let file = fs::File::open(&backup_path).map_err(|e| format!("Cannot open backup: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let restore_base = home.join("AppData").join("Roaming");
    let total = archive.len();

    for i in 0..total {
        let mut zf = archive.by_index(i).map_err(|e| e.to_string())?;
        let out_path = restore_base.join(zf.name());
        if zf.name().ends_with('/') {
            fs::create_dir_all(&out_path).ok();
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            if let Ok(mut out_file) = fs::File::create(&out_path) {
                let mut buf = Vec::new();
                zf.read_to_end(&mut buf).ok();
                use std::io::Write;
                out_file.write_all(&buf).ok();
                let _ = window.emit("uninstall-progress",
                    format!("♻️  ({}/{}) {}", i + 1, total, zf.name()));
            }
        }
    }

    let _ = window.emit("uninstall-progress", "✅ Restore complete!".to_string());
    Ok(())
}


/// Remove all PATH entries (user + system) that contain the app name keyword.
fn clean_env_paths(keyword: &str) -> Vec<String> {
    let mut removed = Vec::new();
    let kw = keyword.to_lowercase();

    // --- User PATH (HKCU\Environment) ---
    if let Ok(hkcu_env) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", winreg::enums::KEY_READ | winreg::enums::KEY_WRITE)
    {
        if let Ok(path_val) = hkcu_env.get_value::<String, _>("Path") {
            let parts: Vec<&str> = path_val.split(';').collect();
            let (keep, drop): (Vec<&str>, Vec<&str>) = parts
                .iter()
                .partition(|p| !p.to_lowercase().contains(&kw));
            for d in &drop { removed.push(format!("[User PATH] {}", d)); }
            if !drop.is_empty() {
                let new_path = keep.join(";");
                let _ = hkcu_env.set_value("Path", &new_path);
            }
        }
    }

    // --- System PATH (HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment) ---
    if let Ok(sys_env) = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
        )
    {
        if let Ok(path_val) = sys_env.get_value::<String, _>("Path") {
            let parts: Vec<&str> = path_val.split(';').collect();
            let (keep, drop): (Vec<&str>, Vec<&str>) = parts
                .iter()
                .partition(|p| !p.to_lowercase().contains(&kw));
            for d in &drop { removed.push(format!("[System PATH] {}", d)); }
            if !drop.is_empty() {
                let new_path = keep.join(";");
                let _ = sys_env.set_value("Path", &new_path);
            }
        }
    }

    removed
}

#[tauri::command]
async fn uninstall_app(uninstall_cmd: Option<String>, name: String, deep_clean: bool, window: tauri::Window) -> Result<String, String> {
    let name_lower = name.to_lowercase();

    macro_rules! emit {
        ($msg:expr) => {{
            let _ = window.emit("uninstall-progress", $msg.to_string());
        }};
    }

    // ── Step 1: Run the actual uninstaller ──────────────────────────────────
    let mut uninstalled = false;
    emit!(format!("🚀 Starting uninstall for: {}", name));

    if let Some(ref cmd) = uninstall_cmd {
        emit!(format!("🔧 Running: {}", cmd));
        let cmd_clean = cmd
            .replace("MsiExec.exe /I", "MsiExec.exe /X")
            .replace("msiexec.exe /I", "msiexec.exe /X")
            .replace("MsiExec.exe /i", "MsiExec.exe /X")
            .replace("msiexec /i", "msiexec /X");

        let final_cmd = if cmd_clean.to_lowercase().contains("msiexec") {
            format!("{} /quiet /norestart", cmd_clean)
        } else {
            format!("{} /S", cmd_clean)
        };

        let result = Command::new("cmd.exe")
            .args(&["/c", &format!("\"{}\"", final_cmd)])
            .output();

        match result {
            Ok(o) if o.status.success() => {
                emit!("✅ Uninstaller exited successfully.");
                uninstalled = true;
            }
            Ok(o) => emit!(format!("⚠️  Uninstaller exit code {:?} — trying winget fallback.", o.status.code())),
            Err(e) => emit!(format!("❌ Could not launch uninstaller: {} — trying winget fallback.", e)),
        }
    } else {
        emit!("ℹ️  No registry uninstall command found — trying winget.");
    }

    // ── Step 2: Winget fallback ─────────────────────────────────────────────
    if !uninstalled {
        emit!(format!("🔍 Trying winget for: {}", name));
        let winget_result = Command::new("cmd.exe")
            .args(&["/c", &format!("winget uninstall --name \"{}\" --silent --accept-source-agreements 2>&1", name)])
            .output();

        match winget_result {
            Ok(o) => {
                let out = String::from_utf8_lossy(&o.stdout);
                emit!(format!("winget → {}", out.trim()));
                if o.status.success() { uninstalled = true; }
            }
            Err(e) => emit!(format!("❌ winget error: {}", e)),
        }
    }

    if uninstalled {
        emit!("✅ App uninstalled successfully.");
    } else {
        emit!("⚠️  Could not auto-uninstall. Deep clean will still run.");
    }

    // ── Step 3: Deep clean ──────────────────────────────────────────────────
    if deep_clean {
        emit!("🧹 Starting deep clean...");
        let home = dirs::home_dir().ok_or("Could not find home directory")?;

        let search_paths = vec![
            home.join("AppData").join("Roaming"),
            home.join("AppData").join("Local"),
            home.join("AppData").join("LocalLow"),
            home.join("Desktop"),
            PathBuf::from("C:\\Users\\Public\\Desktop"),
            PathBuf::from("C:\\ProgramData"),
            PathBuf::from("C:\\Program Files"),
            PathBuf::from("C:\\Program Files (x86)"),
        ];

        for base_path in &search_paths {
            if let Ok(entries) = fs::read_dir(base_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.to_string_lossy().to_lowercase().contains(&name_lower) {
                        if path.is_dir() {
                            match fs::remove_dir_all(&path) {
                                Ok(_)  => emit!(format!("🗑️  Deleted folder: {}", path.display())),
                                Err(e) => emit!(format!("⛔ Cannot delete {}: {}", path.display(), e)),
                            }
                        } else if path.is_file() {
                            match fs::remove_file(&path) {
                                Ok(_)  => emit!(format!("🗑️  Deleted file: {}", path.display())),
                                Err(e) => emit!(format!("⛔ Cannot delete {}: {}", path.display(), e)),
                            }
                        }
                    }
                }
            }
        }

        // Clean PATH env vars
        emit!("🔑 Cleaning environment variables...");
        let removed_paths = clean_env_paths(&name_lower);
        if removed_paths.is_empty() {
            emit!("ℹ️  No PATH entries found for this app.");
        } else {
            for r in &removed_paths {
                emit!(format!("✂️  Removed from PATH: {}", r));
            }
        }

        // Remove leftover registry keys
        emit!("📋 Cleaning registry entries...");
        let unreg_script = format!(r#"
            $paths = @(
                'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
                'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
                'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
            )
            foreach ($p in $paths) {{
                Get-ChildItem $p -ErrorAction SilentlyContinue | ForEach-Object {{
                    $dn = ($_ | Get-ItemProperty -ErrorAction SilentlyContinue).DisplayName
                    if ($dn -and $dn.ToLower().Contains('{}')) {{
                        Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
                        Write-Host "Removed registry key: $($_.PSPath)"
                    }}
                }}
            }}
        "#, name_lower);

        let reg_result = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &unreg_script])
            .creation_flags(0x08000000)
            .output();

        if let Ok(o) = reg_result {
            let out = String::from_utf8_lossy(&o.stdout);
            for line in out.lines() {
                if !line.trim().is_empty() {
                    emit!(line.to_string());
                }
            }
        }
    }

    emit!("--- DONE ---");
    Ok(format!("Uninstall of '{}' completed.", name))
}

#[tauri::command]
async fn scan_security() -> Result<Vec<String>, String> {
    // 1. Actually trigger a real Quick Scan
    let _ = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        .args(&["-Command", "Start-MpScan -ScanType QuickScan"])
        .output();

    // 2. Fetch the active threats after the scan
    let output = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        .args(&["-Command", "Get-MpThreat | Select-Object -ExpandProperty Resources"])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let threats: Vec<String> = stdout.lines().map(|s| s.to_string()).filter(|s| !s.is_empty()).collect();
            Ok(threats)
        },
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    match local_ip() {
        Ok(ip) => Ok(ip.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

use warp::Filter;
use std::sync::Arc;
use enigo::{Enigo, Mouse, Keyboard, Button, Coordinate, Direction, Key, Settings};
use futures_util::{StreamExt, SinkExt};
#[tauri::command]
fn open_folder(path: String, app_name: String) -> Result<(), String> {
    let mut target_path = path.trim_matches(|c| c == '"' || c == '\'').to_string();
    
    // 1. Validate if the provided path actually exists
    let path_exists = !target_path.is_empty() && std::path::Path::new(&target_path).exists();
    
    // 2. If path is broken, try to "Locate" the Application (.exe)
    if !path_exists || target_path.is_empty() {
        let clean_name = app_name.split(' ').next().unwrap_or(&app_name).to_lowercase();
        let user = std::env::var("USERNAME").unwrap_or_default();
        
        // Try searching common root folders for the EXE
        let search_roots = vec![
            "C:\\Program Files".to_string(),
            "C:\\Program Files (x86)".to_string(),
            format!("C:\\Users\\{}\\AppData\\Local", user),
            format!("C:\\Users\\{}\\AppData\\Roaming", user),
        ];

        for root in &search_roots {
            if root.is_empty() || !std::path::Path::new(root).exists() { continue; }
            
            // Fast search: Look for the EXE in the root's first 2 levels (most apps are in Root\App\App.exe)
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.file_name().unwrap_or_default().to_string_lossy().to_lowercase().contains(&clean_name) {
                        // We found a folder that looks right!
                        if let Ok(sub_entries) = std::fs::read_dir(&path) {
                            for sub_entry in sub_entries.flatten() {
                                let sub_path = sub_entry.path();
                                // Check if there is an EXE inside
                                if sub_path.extension().map_or(false, |ext| ext == "exe") {
                                    target_path = path.to_string_lossy().to_string();
                                    break;
                                }
                            }
                        }
                    }
                    if !target_path.is_empty() { break; }
                }
            }
            if !target_path.is_empty() { break; }
        }
    }

    if target_path.is_empty() || !std::path::Path::new(&target_path).exists() {
        return Err(format!("Could not find the current location for '{}'. Please ensure the app is still installed.", app_name));
    }

    Command::new("cmd")
        .args(&["/C", "start", "", &target_path])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_cursor_pos() -> Option<(i32, i32)> {
    #[cfg(target_os = "windows")]
    unsafe {
        let mut pt = winapi::shared::windef::POINT { x: 0, y: 0 };
        if winapi::um::winuser::GetCursorPos(&mut pt) != 0 {
            return Some((pt.x, pt.y));
        }
    }
    None
}

fn capture_screen_jpeg() -> Result<String, String> {
    use screenshots::Screen;
    use screenshots::image::{DynamicImage, ImageFormat, imageops, Rgb};
    use std::io::Cursor;

    let screens = Screen::all().map_err(|e| format!("Screen enum error: {}", e))?;
    let screen = screens.into_iter().next().ok_or("No screen found")?;

    let sw = screen.display_info.width as f64;
    let sh = screen.display_info.height as f64;

    // Native GDI capture — no PowerShell, not flagged by AV
    let capture = screen.capture().map_err(|e| format!("Capture error: {}", e))?;
    let w = capture.width();
    let h = capture.height();

    // Grab cursor position BEFORE we start encoding
    let cursor = get_cursor_pos();

    // Convert RGBA → RGB (JPEG doesn't support alpha)
    let rgb = DynamicImage::ImageRgba8(capture).to_rgb8();

    // Scale down to 640px wide for lower latency
    let target_w: u32 = 640;
    let target_h = ((h as f64 * target_w as f64 / w as f64) as u32).max(1);
    let mut scaled = imageops::resize(&rgb, target_w, target_h, imageops::FilterType::Nearest);

    // Draw cursor dot on the scaled image
    if let Some((cx, cy)) = cursor {
        let scale_x = target_w as f64 / sw;
        let scale_y = target_h as f64 / sh;
        let px = (cx as f64 * scale_x) as i32;
        let py = (cy as f64 * scale_y) as i32;

        // Outer white ring (radius 7) then red fill (radius 5)
        for dy in -7i32..=7 {
            for dx in -7i32..=7 {
                let dist = dx * dx + dy * dy;
                let nx = px + dx;
                let ny = py + dy;
                if nx < 0 || ny < 0 || nx >= target_w as i32 || ny >= target_h as i32 { continue; }
                if dist <= 25 {
                    // Red fill
                    scaled.put_pixel(nx as u32, ny as u32, Rgb([220, 38, 38]));
                } else if dist <= 49 {
                    // White outline
                    scaled.put_pixel(nx as u32, ny as u32, Rgb([255, 255, 255]));
                }
            }
        }
    }

    // Encode to JPEG in memory
    let mut buf = Cursor::new(Vec::<u8>::new());
    DynamicImage::ImageRgb8(scaled)
        .write_to(&mut buf, ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG encode error: {}", e))?;

    Ok(b64_encode(buf.get_ref()))
}



/// Simple base64 encoder — avoids adding the `base64` crate
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}



#[tauri::command]
fn start_remote_server(port: Option<u16>, state: tauri::State<AppState>) -> Result<String, String> {
    let connections = state.active_remote_connections.clone();
    
    // Kill existing server task immediately to drop all connections
    if let Some(handle) = state.server_task.lock().unwrap().take() {
        handle.abort();
        // Reset connection count
        state.active_remote_connections.store(0, std::sync::atomic::Ordering::SeqCst);
    }
    
    let listen_port = if let Some(p) = port {
        state.config.lock().unwrap().server_port = p;
        p
    } else {
        state.config.lock().unwrap().server_port
    };
    
    let handle = tauri::async_runtime::spawn(async move {
        let html = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>PC Remote Control</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0f172a; color: #e2e8f0;
    font-family: system-ui, sans-serif;
    height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
  }

  /* ── Tabs ── */
  #tabs { display: flex; background: #1e293b; border-bottom: 1px solid #334155; flex-shrink: 0; }
  .tab { flex: 1; padding: 12px 8px; text-align: center; font-size: 13px; font-weight: 600; cursor: pointer; color: #64748b; }
  .tab.active { color: #38bdf8; border-bottom: 2px solid #38bdf8; }

  /* ── Remote pane: screen top + touchpad bottom ── */
  #remote-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

  /* SCREEN – top 45% */
  #screen-section {
    height: 45%; flex-shrink: 0;
    background: #000; position: relative;
    display: flex; align-items: center; justify-content: center;
    border-bottom: 2px solid #1e293b;
  }
  #screen-img {
    max-width: 100%; max-height: 100%;
    object-fit: contain; display: block;
  }
  #screen-placeholder {
    color: #475569; font-size: 13px; text-align: center; padding: 20px;
  }
  #screen-bar {
    position: absolute; top: 0; left: 0; right: 0;
    background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    font-size: 11px;
  }
  #screen-status { color: #94a3b8; flex: 1; }
  #ws-dot { width: 6px; height: 6px; border-radius: 50%; background: #ef4444; flex-shrink: 0; }
  .ctrl-btn {
    background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
    color: white; padding: 4px 10px; border-radius: 14px; font-size: 10px; cursor: pointer;
  }
  .ctrl-btn.on { background: #dc2626; border-color: #ef4444; }

  /* TOUCHPAD – bottom fills the rest */
  #touchpad-section {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
  }
  #pad-label {
    background: #1e293b; padding: 6px 12px; font-size: 10px;
    color: #475569; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; text-align: center; flex-shrink: 0;
  }
  #touchpad {
    flex: 1; background: #0d1b2a;
    position: relative; touch-action: none; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  #touchpad-hint {
    color: rgba(255,255,255,0.15); font-size: 15px; font-weight: 600;
    pointer-events: none; text-align: center;
  }
  #mouse-btns {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;
    padding: 8px 10px; background: #111827; flex-shrink: 0;
  }
  .mbtn {
    border: none; border-radius: 10px; padding: 14px 4px;
    font-size: 12px; font-weight: 700; color: white; cursor: pointer;
    transition: transform 0.1s, opacity 0.1s;
  }
  .mbtn:active { transform: scale(0.94); opacity: 0.8; }
  #btn-left  { background: #2563eb; }
  #btn-right { background: #7c3aed; }
  #btn-scroll-up   { background: #0f766e; font-size: 16px; }
  #btn-scroll-down { background: #0f766e; font-size: 16px; }

  /* ── Keyboard pane ── */
  #keyboard-pane {
    flex: 1; display: none; flex-direction: column;
    gap: 12px; padding: 16px; overflow: auto;
  }
  #type-area {
    width: 100%; height: 80px; background: #1e293b;
    border: 1px solid #334155; border-radius: 8px;
    color: white; padding: 10px; font-size: 14px; resize: none;
  }
  #btn-send { padding: 12px; background: #0284c7; border: none; border-radius: 8px; color: white; font-weight: 700; cursor: pointer; }
  .shortcut-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .sk { padding: 10px 2px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #cbd5e1; text-align: center; font-size: 11px; cursor: pointer; }
  .section-label { font-size: 11px; color: #475569; font-weight: 600; text-transform: uppercase; }

  /* ── Debug log ── */
  #debug-log {
    background: #000; color: #4ade80; font-family: monospace; font-size: 9px;
    padding: 6px 8px; height: 70px; overflow-y: auto; flex-shrink: 0;
    border-top: 1px solid #1e293b; white-space: pre-wrap; word-break: break-all;
  }
</style>
</head>
<body>
<div id="tabs">
  <div class="tab active" id="tab-remote" onclick="showTab('remote')">🖱️ Remote</div>
  <div class="tab" id="tab-key" onclick="showTab('keyboard')">⌨️ Keyboard</div>
</div>

<!-- REMOTE VIEW -->
<div id="remote-pane">

  <!-- TOP: Screen Share -->
  <div id="screen-section">
    <div id="screen-bar">
      <span id="ws-dot"></span>
      <span id="screen-status">Screen off</span>
      <button class="ctrl-btn" onclick="testCapture()">🔍 Test</button>
      <button id="btn-screen" class="ctrl-btn" onclick="toggleScreen()">▶ Start</button>
    </div>
    <img id="screen-img" src="about:blank" style="display:none" />
    <div id="screen-placeholder">📺 Press ▶ Start to share screen</div>
  </div>

  <!-- BOTTOM: Touchpad -->
  <div id="touchpad-section">
    <div id="pad-label">Touchpad — Swipe to move · Tap to click · Hold to right-click</div>
    <div id="touchpad">
      <div id="touchpad-hint">Swipe here</div>
    </div>
    <div id="mouse-btns">
      <button class="mbtn" id="btn-left"  onclick="send({type:'click',btn:'left'})">LEFT</button>
      <button class="mbtn" id="btn-scroll-up"   onclick="send({type:'scroll',dy:-5})">▲</button>
      <button class="mbtn" id="btn-scroll-down" onclick="send({type:'scroll',dy:5})">▼</button>
      <button class="mbtn" id="btn-right" onclick="send({type:'click',btn:'right'})" style="grid-column: span 3">RIGHT CLICK</button>
    </div>
  </div>
</div>

<!-- KEYBOARD VIEW -->
<div id="keyboard-pane">
  <span class="section-label">Type Text</span>
  <textarea id="type-area" placeholder="Type here…"></textarea>
  <button id="btn-send" onclick="sendText()">⌨️ Send Text</button>
  <span class="section-label">Shortcuts</span>
  <div class="shortcut-grid">
    <div class="sk" onclick="sendKey('ctrl+c')">Ctrl+C</div>
    <div class="sk" onclick="sendKey('ctrl+v')">Ctrl+V</div>
    <div class="sk" onclick="sendKey('ctrl+z')">Ctrl+Z</div>
    <div class="sk" onclick="sendKey('ctrl+a')">Ctrl+A</div>
    <div class="sk" onclick="sendKey('win')">Win</div>
    <div class="sk" onclick="sendKey('escape')">Esc</div>
    <div class="sk" onclick="sendKey('enter')">Enter</div>
    <div class="sk" onclick="sendKey('backspace')">⌫</div>
    <div class="sk" onclick="sendKey('tab')">Tab</div>
    <div class="sk" onclick="sendKey('delete')">Del</div>
    <div class="sk" onclick="sendKey('arrow_up')">↑</div>
    <div class="sk" onclick="sendKey('arrow_down')">↓</div>
    <div class="sk" onclick="sendKey('arrow_left')">←</div>
    <div class="sk" onclick="sendKey('arrow_right')">→</div>
    <div class="sk" onclick="sendKey('alt+tab')">Alt+Tab</div>
    <div class="sk" onclick="sendKey('alt+f4')">Alt+F4</div>
  </div>
</div>

<div id="debug-log">Debug log ready...</div>

<script>
function log(msg) {
  const el = document.getElementById('debug-log');
  if (el) {
    el.textContent += '\n[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.scrollTop = el.scrollHeight;
  }
}
window.onerror = (m, s, l, c, e) => log('ERR: ' + m + ' at ' + s + ':' + l);

const ws = new WebSocket(`ws://${location.host}/ws`);
const wsDot = document.getElementById('ws-dot');
ws.onopen = () => { log('WS connected'); wsDot.style.background = '#4ade80'; };
ws.onclose = () => { 
  log('WS closed'); 
  wsDot.style.background = '#ef4444';
  document.body.innerHTML = `
    <div style="height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#0f172a; color:white; font-family:sans-serif; text-align:center; padding:20px;">
      <div style="font-size:4rem; margin-bottom:20px;">⚠️</div>
      <h1 style="color:#ef4444; margin-bottom:10px;">Connection Lost</h1>
      <p>The server was restarted or the port was changed.</p>
      <p style="font-size:0.9rem; color:#94a3b8; margin-top:20px;">This page will refresh automatically...</p>
    </div>
  `;
  setTimeout(() => location.reload(), 2000);
};
ws.onerror = () => { log('WS error'); wsDot.style.background = '#f59e0b'; };

function send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); else log('WS not ready, state=' + ws.readyState); }

/* ── Tab switching ── */
function showTab(name) {
  document.getElementById('remote-pane').style.display = name === 'remote' ? 'flex' : 'none';
  document.getElementById('keyboard-pane').style.display = name === 'keyboard' ? 'flex' : 'none';
  document.getElementById('tab-remote').classList.toggle('active', name === 'remote');
  document.getElementById('tab-key').classList.toggle('active', name === 'keyboard');
}

/* ── Touchpad ── */
const pad = document.getElementById('touchpad');
let lastX = 0, lastY = 0, holdTimer = null, hasMoved = false;

pad.addEventListener('touchstart', e => {
  e.preventDefault();
  const touch = e.touches[0];
  lastX = touch.clientX;
  lastY = touch.clientY;
  hasMoved = false;

  // Long press = right click
  holdTimer = setTimeout(() => {
    hasMoved = true; // prevent left-click on touchend
    send({type:'click', btn:'right'});
    log('Right click');
  }, 600);
  document.getElementById('touchpad-hint').style.display = 'none';
}, {passive: false});

pad.addEventListener('touchmove', e => {
  e.preventDefault();
  const touch = e.touches[0];
  const cx = touch.clientX, cy = touch.clientY;
  const dx = cx - lastX, dy = cy - lastY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    clearTimeout(holdTimer);
    hasMoved = true;
    send({type:'move', dx: Math.round(dx * 2), dy: Math.round(dy * 2)});
    lastX = cx; lastY = cy;
  }
}, {passive: false});

pad.addEventListener('touchend', e => {
  e.preventDefault();
  clearTimeout(holdTimer);
  if (!hasMoved) {
    send({type:'click', btn:'left'});
    log('Left click');
  }
  hasMoved = false;
}, {passive: false});

/* ── Screen sharing via HTTP polling ── */
let screenInterval = null;
const screenImg = document.getElementById('screen-img');
const statusEl  = document.getElementById('screen-status');
const screenBtn = document.getElementById('btn-screen');

// WS frames as fallback
ws.onmessage = (ev) => {
  try {
    const data = JSON.parse(ev.data);
    if (data.type === 'frame' && data.data) {
      screenImg.src = 'data:image/jpeg;base64,' + data.data;
      statusEl.textContent = '🟢 Live (WS)';
    }
  } catch(e) { console.error('WS parse error', e); }
};

async function pollScreen() {
  try {
    const res = await fetch('/screenshot', { cache: 'no-store' });
    if (!res.ok) { 
      const txt = await res.text();
      log('HTTP Error: ' + res.status + ' ' + txt);
      statusEl.textContent = '⚠ HTTP ' + res.status; 
      return; 
    }
    const json = await res.json();
    if (json.ok && json.data) {
      screenImg.src = 'data:image/jpeg;base64,' + json.data;
      statusEl.textContent = '🟢 Live';
    } else {
      const err = json.error || 'empty frame';
      statusEl.textContent = '⚠ ' + err;
      log('Capture Error: ' + err);
    }
  } catch(e) {
    statusEl.textContent = '⚠ fetch: ' + e.message;
    log('Fetch Error: ' + e.message);
  }
}

function toggleScreen() {
  if (screenInterval) { stopScreen(); return; }
  screenBtn.textContent = '⏹ Stop'; screenBtn.classList.add('on');
  statusEl.textContent = 'Connecting…';
  document.getElementById('screen-placeholder').style.display = 'none';
  screenImg.style.display = 'block';
  send({type:'start_screen'});
  pollScreen();
  screenInterval = setInterval(pollScreen, 600);
}
function stopScreen() {
  clearInterval(screenInterval); screenInterval = null;
  send({type:'stop_screen'});
  screenBtn.textContent = '▶ Start'; screenBtn.classList.remove('on');
  statusEl.textContent = 'Screen off';
  screenImg.style.display = 'none';
  document.getElementById('screen-placeholder').style.display = 'block';
}

/* ── Keyboard ── */
function sendText() {
  const txt = document.getElementById('type-area').value;
  if (txt) { send({type:'type', text: txt}); document.getElementById('type-area').value = ''; }
}
function sendKey(k) { send({type:'key', key: k}); }
async function testCapture() {
  log('--- Testing capture ---');
  try {
    const res = await fetch('/screenshot', { cache: 'no-store' });
    log('HTTP status: ' + res.status);
    const text = await res.text();
    log('Response (first 200 chars): ' + text.substring(0, 200));
    try {
      const json = JSON.parse(text);
      if (json.ok) { log('OK! Data length: ' + (json.data ? json.data.length : 0)); }
      else { log('Error from server: ' + json.error); }
    } catch { log('Response is not JSON!'); }
  } catch(e) { log('Network error: ' + e.message); }
}
async function checkScreens() {
  log('Checking screens...');
  try {
    const res = await fetch('/check-screens');
    const json = await res.json();
    log('Screens Found: ' + JSON.stringify(json));
  } catch(e) { log('Check Error: ' + e.message); }
}
checkScreens();
</script>
</body>
</html>"#;

        let route_html = warp::path::end().map(move || warp::reply::html(html));

        let enigo = Arc::new(Mutex::new(Enigo::new(&Settings::default()).unwrap()));
        let screen_active = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let ws_route = warp::path("ws")
            .and(warp::ws())
            .map({
                let enigo = enigo.clone();
                let screen_active = screen_active.clone();
                let connections = connections.clone();
                move |ws: warp::ws::Ws| {
                    let enigo = enigo.clone();
                    let screen_active = screen_active.clone();
                    let connections = connections.clone();
                    ws.on_upgrade(move |websocket| async move {
                        connections.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let (ws_tx, mut ws_rx) = websocket.split();
                        let ws_tx = Arc::new(tokio::sync::Mutex::new(ws_tx));

                        while let Some(result) = ws_rx.next().await {
                            if let Ok(msg) = result {
                                if let Ok(text) = msg.to_str() {
                                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(text) {
                                        let msg_type = data["type"].as_str().unwrap_or("");
                                        match msg_type {
                                            "move" => {
                                                let dx = data["dx"].as_f64().unwrap_or(0.0) as i32;
                                                let dy = data["dy"].as_f64().unwrap_or(0.0) as i32;
                                                let mut e = enigo.lock().unwrap();
                                                e.move_mouse(dx, dy, Coordinate::Rel).ok();
                                            }
                                            "move_abs" => {
                                                let x_ratio = data["x"].as_f64().unwrap_or(0.0);
                                                let y_ratio = data["y"].as_f64().unwrap_or(0.0);
                                                
                                                // Windows absolute move is 0..65535
                                                let target_x = (x_ratio * 65535.0) as i32;
                                                let target_y = (y_ratio * 65535.0) as i32;
                                                let mut e = enigo.lock().unwrap();
                                                e.move_mouse(target_x, target_y, Coordinate::Abs).ok();
                                            }
                                            "click" => {
                                                let btn = if data["btn"] == "right" { Button::Right } else { Button::Left };
                                                let mut e = enigo.lock().unwrap();
                                                e.button(btn, Direction::Click).ok();
                                            }
                                            "scroll" => {
                                                let dy = data["dy"].as_i64().unwrap_or(0) as i32;
                                                let mut e = enigo.lock().unwrap();
                                                e.scroll(dy, enigo::Axis::Vertical).ok();
                                            }
                                            "type" => {
                                                if let Some(txt) = data["text"].as_str() {
                                                    let mut e = enigo.lock().unwrap();
                                                    e.text(txt).ok();
                                                }
                                            }
                                            "key" => {
                                                if let Some(k) = data["key"].as_str() {
                                                    let mut e = enigo.lock().unwrap();
                                                    let key = match k {
                                                        "escape"      => Some(Key::Escape),
                                                        "enter"       => Some(Key::Return),
                                                        "backspace"   => Some(Key::Backspace),
                                                        "tab"         => Some(Key::Tab),
                                                        "delete"      => Some(Key::Delete),
                                                        "arrow_up"    => Some(Key::UpArrow),
                                                        "arrow_down"  => Some(Key::DownArrow),
                                                        "arrow_left"  => Some(Key::LeftArrow),
                                                        "arrow_right" => Some(Key::RightArrow),
                                                        "win"         => Some(Key::Meta),
                                                        "ctrl+c" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('c'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+v" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('v'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+z" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('z'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+s" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('s'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+a" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('a'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+x" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('x'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+w" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('w'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "ctrl+t" => { e.key(Key::Control, Direction::Press).ok(); e.key(Key::Unicode('t'), Direction::Click).ok(); e.key(Key::Control, Direction::Release).ok(); None }
                                                        "alt+f4"  => { e.key(Key::Alt, Direction::Press).ok(); e.key(Key::F4, Direction::Click).ok(); e.key(Key::Alt, Direction::Release).ok(); None }
                                                        "alt+tab" => { e.key(Key::Alt, Direction::Press).ok(); e.key(Key::Tab, Direction::Click).ok(); e.key(Key::Alt, Direction::Release).ok(); None }
                                                        _ => None,
                                                    };
                                                    if let Some(k) = key {
                                                        e.key(k, Direction::Click).ok();
                                                    }
                                                }
                                            }
                                            "start_screen" => {
                                                screen_active.store(true, std::sync::atomic::Ordering::SeqCst);
                                                let ws_tx2 = ws_tx.clone();
                                                let screen_active2 = screen_active.clone();
                                                tokio::spawn(async move {
                                                    while screen_active2.load(std::sync::atomic::Ordering::SeqCst) {
                                                        match tokio::task::spawn_blocking(capture_screen_jpeg).await {
                                                            Ok(Ok(b64)) => {
                                                                let payload = serde_json::json!({"type": "frame", "data": b64}).to_string();
                                                                let mut tx = ws_tx2.lock().await;
                                                                if tx.send(warp::ws::Message::text(payload)).await.is_err() {
                                                                    break;
                                                                }
                                                            }
                                                            Ok(Err(_)) => { /* capture failed, skip frame */ }
                                                            Err(_) => break,
                                                        }
                                                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                                                    }
                                                });
                                            }
                                            "stop_screen" => {
                                                screen_active.store(false, std::sync::atomic::Ordering::SeqCst);
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        }
                        screen_active.store(false, std::sync::atomic::Ordering::SeqCst);
                        connections.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    })
                }
            });

        let screenshot_route = warp::path("screenshot")
            .and(warp::get())
            .map(|| {
                // Return JSON with the frame data OR the error message for debugging
                let result = capture_screen_jpeg();
                let json = match result {
                    Ok(b64) => serde_json::json!({"ok": true, "data": b64}).to_string(),
                    Err(e) => serde_json::json!({"ok": false, "error": e}).to_string(),
                };
                warp::http::Response::builder()
                    .header("Content-Type", "application/json")
                    .header("Cache-Control", "no-store")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(json.into_bytes())
                    .unwrap_or_default()
            });

        let check_screens_route = warp::path("check-screens")
            .map(|| {
                let screens = screenshots::Screen::all().unwrap_or_default();
                let info: Vec<_> = screens.iter().map(|s| format!("{}x{}", s.display_info.width, s.display_info.height)).collect();
                serde_json::json!({"count": screens.len(), "screens": info}).to_string()
            });

        let routes = route_html.or(ws_route).or(screenshot_route).or(check_screens_route);
        warp::serve(routes).run(([0, 0, 0, 0], listen_port)).await;
    });

    state.server_task.lock().unwrap().replace(handle);

    Ok(format!("Server started on port {}", listen_port))
}

#[tauri::command]
fn get_remote_connection_count(state: tauri::State<AppState>) -> u32 {
    state.active_remote_connections.load(std::sync::atomic::Ordering::SeqCst)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateItem {
    id: String,
    name: String,
    manager: String,
    current_version: String,
    new_version: String,
}

#[tauri::command]
async fn scan_for_updates(managers: Vec<String>) -> Result<Vec<UpdateItem>, String> {
    let mut script = String::from("$updates = @()\n$ErrorActionPreference = 'SilentlyContinue'\n");

    if managers.contains(&"pip".to_string()) {
        script.push_str(r#"
try {
    $pip = python -m pip list --outdated --format=json | ConvertFrom-Json
    foreach ($p in $pip) {
        $updates += [PSCustomObject]@{ id = $p.name; name = $p.name; manager = "pip"; current_version = $p.version; new_version = $p.latest_version }
    }
} catch {}
"#);
    }

    if managers.contains(&"npm".to_string()) {
        script.push_str(r#"
try {
    $npmStr = npm outdated -g --json | Out-String
    if (-not [string]::IsNullOrWhiteSpace($npmStr)) {
        $npm = $npmStr | ConvertFrom-Json
        if ($npm -ne $null) {
            foreach ($prop in $npm.psobject.properties) {
                $updates += [PSCustomObject]@{ id = $prop.Name; name = $prop.Name; manager = "npm"; current_version = $prop.Value.current; new_version = $prop.Value.latest }
            }
        }
    }
} catch {}
"#);
    }

    if managers.contains(&"winget".to_string()) {
        script.push_str(r#"
try {
    $wg = winget upgrade | Out-String
    $lines = $wg -split "`n"
    $started = $false
    foreach ($line in $lines) {
        if ($line -match '---') { $started = $true; continue }
        if (-not $started) { continue }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^\d+ upgrades available') { continue }
        
        $parts = $line -split '\s{2,}'
        if ($parts.Count -ge 4) {
            $updates += [PSCustomObject]@{ id = $parts[1]; name = $parts[0]; manager = "winget"; current_version = $parts[2]; new_version = $parts[3] }
        }
    }
} catch {}
"#);
    }

    if managers.contains(&"choco".to_string()) {
        script.push_str(r#"
try {
    $ch = choco outdated -r | Out-String
    $lines = $ch -split "`n"
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split '\|'
        if ($parts.Count -ge 3) {
            $updates += [PSCustomObject]@{ id = $parts[0]; name = $parts[0]; manager = "choco"; current_version = $parts[1]; new_version = $parts[2] }
        }
    }
} catch {}
"#);
    }

    if managers.contains(&"wsus".to_string()) {
        script.push_str(r#"
try {
    if (-not (Get-Module -ListAvailable -Name PSWindowsUpdate)) { 
        Install-Module PSWindowsUpdate -Force -Scope CurrentUser -ErrorAction SilentlyContinue 
    }
    Import-Module PSWindowsUpdate
    $wu = Get-WindowsUpdate
    foreach ($w in $wu) {
        $updates += [PSCustomObject]@{ id = $w.KBArticleID; name = $w.Title; manager = "wsus"; current_version = "Current"; new_version = "Update Available" }
    }
} catch {}
"#);
    }

    script.push_str("$updates | ConvertTo-Json -Compress\n");

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        .args(&["-NoProfile", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.trim().is_empty() {
                return Ok(vec![]);
            }
            // Parse JSON into Vec<UpdateItem>
            let parsed: Result<Vec<UpdateItem>, _> = serde_json::from_str(&stdout);
            match parsed {
                Ok(items) => Ok(items),
                Err(_) => {
                    // It might be a single object instead of an array if only 1 item
                    let single: Result<UpdateItem, _> = serde_json::from_str(&stdout);
                    match single {
                        Ok(item) => Ok(vec![item]),
                        Err(e) => Err(format!("Failed to parse JSON: {} | output: {}", e, stdout))
                    }
                }
            }
        },
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
async fn install_specific_updates(
    window: Window,
    updates: Vec<UpdateItem>
) -> Result<String, String> {
    tauri::async_runtime::spawn(async move {
        let mut script = String::from("$ErrorActionPreference = 'SilentlyContinue'\n");
        
        for item in updates {
            script.push_str(&format!("Write-Output '>>> Upgrading: {} via {}'\n", item.name, item.manager));
            
            match item.manager.as_str() {
                "pip" => {
                    script.push_str(&format!("python -m pip install --upgrade '{}' | Out-String | Write-Output\n", item.id));
                },
                "npm" => {
                    script.push_str(&format!("npm install -g '{}'@latest | Out-String | Write-Output\n", item.id));
                },
                "winget" => {
                    script.push_str(&format!("winget upgrade --id '{}' --accept-source-agreements --accept-package-agreements | Out-String | Write-Output\n", item.id));
                },
                "choco" => {
                    script.push_str(&format!("choco upgrade '{}' -y | Out-String | Write-Output\n", item.id));
                },
                "wsus" => {
                    script.push_str(&format!("Import-Module PSWindowsUpdate\nInstall-WindowsUpdate -KBArticleID '{}' -AcceptAll -AutoReboot:$false | Out-String | Write-Output\n", item.id));
                },
                _ => {}
            }
        }
        
        script.push_str("Write-Output '--- COMPLETE ---'\n");

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut child = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .args(&["-NoProfile", "-Command", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("Failed to start powershell");

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(l) = line {
                    window.emit("updater-log", l).unwrap_or(());
                }
            }
        }
        
        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    window.emit("updater-log", format!("ERROR: {}", l)).unwrap_or(());
                }
            }
        }
        
        let _ = child.wait();
    });

    Ok("Update sequence started".into())
}

#[tauri::command]
fn apply_performance_profile(profile_id: String) -> Result<String, String> {
    let guid = match profile_id.as_str() {
        "silent" => "a1841308-3541-4fab-bc81-f71556f20b4a", // Power Saver
        "turbo" => "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",  // High Performance
        _ => "381b4222-f694-41f0-9685-ff5bb260df2e",       // Balanced
    };

    let output = Command::new("powercfg")
        .args(&["/setactive", guid])
        .creation_flags(0x08000000)
        .output();

    if let Ok(_) = output {
        Ok(format!("Applied profile: {}", profile_id))
    } else {
        Err("Failed to apply power profile".into())
    }
}

#[tauri::command]
fn enable_game_mode(apps: Vec<String>) -> Result<String, String> {
    // 1. Set High Performance
    let _ = apply_performance_profile("turbo".into());
    
    // 2. Kill distraction apps
    for app in apps {
        if !app.is_empty() {
            let _ = Command::new("taskkill")
                .args(&["/F", "/IM", &app])
                .creation_flags(0x08000000)
                .output();
        }
    }
    
    Ok("Game Mode Active: High Performance applied & selected apps closed".into())
}

#[tauri::command]
fn enable_focus_mode() -> Result<String, String> {
    // 1. Set Silent Mode
    let _ = apply_performance_profile("silent".into());
    
    // 2. REAL EFFECT: Minimize all windows (Show Desktop)
    let _ = Command::new("powershell")
        .args(&["-NoProfile", "-Command", "(New-Object -ComObject Shell.Application).MinimizeAll()"])
        .creation_flags(0x08000000)
        .output();
    
    Ok("Focus Mode Active: Desktop cleared & system silenced".into())
}

fn fetch_gpu_name() -> String {
    let output = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        .args(&["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"])
        .creation_flags(0x08000000)
        .output();
    if let Ok(o) = output {
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    } else {
        "Unknown GPU".to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gpu_name = fetch_gpu_name();
    
    tauri::Builder::default()
        .setup(|app| {
            let config = load_config(app.handle());
            app.manage(AppState {
                sys: Mutex::new(System::new_all()),
                networks: Mutex::new(Networks::new_with_refreshed_list()),
                prev_net: Mutex::new((0, 0)),
                gpu_name,
                active_remote_connections: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
                config: Mutex::new(config),
                server_task: Mutex::new(None),
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_system_stats, 
            get_installed_apps,
            uninstall_app,
            backup_app_data,
            list_backups,
            restore_backup,
            delete_backup,
            scan_security,
            get_local_ip,
            start_remote_server,
            get_remote_connection_count,
            scan_for_updates,
            install_specific_updates,
            get_processes,
            kill_process,
            open_folder,
            get_config,
            update_config,
            apply_performance_profile,
            enable_game_mode,
            enable_focus_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
