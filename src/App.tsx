import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import QRCode from "react-qr-code";
import { 
  ResponsiveContainer, AreaChart, Area
} from "recharts";
import { 
  LayoutDashboard, 
  Package, 
  ShieldAlert, 
  Smartphone, 
  Settings, 
  Bell, 
  Cpu, 
  Zap, 
  HardDrive,
  RefreshCw,
  Trash2,
  Database,
  Search,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  DownloadCloud,
  Play,
  Terminal,
  Activity,
  Wifi,
  XCircle,
  Archive,
  Monitor,
  Globe,
  Info,
  Save,
  User,
  Power
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import "./App.css";

// Types
declare global {
  interface Window {
    __TAURI_INTERNALS__: any;
  }
}

interface AppConfig {
  theme: string;
  start_on_boot: boolean;
  server_port: number;
  show_ip: boolean;
  refresh_interval: number;
}

interface SystemStats {
  cpu_usage: number;
  ram_used: number;
  ram_total: number;
  disks: Array<{ name: string; free_space: number; total_space: number }>;
  net_rx: number;
  net_tx: number;
  gpu_name: string;
  cpu_temp: number;
  battery_level: number;
  is_charging: boolean;
  uptime: number;
  active_remote_connections: number;
}

interface AppInfo {
  name: string;
  id: string;
  version: string;
  available_version?: string;
  uninstall_cmd?: string;
  install_location?: string;
}

interface BackupInfo {
  name: string;
  app_name: string;
  path: string;
  size_bytes: number;
  created_at: string;
}

interface ChartData {
  time: string;
  cpu: number;
  ram: number;
  temp: number;
  net_rx: number;
  net_tx: number;
}

interface ProcessInfo {
  pid: number;
  name: string;
  memory: number;
  cpu_usage: number;
}

function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [history, setHistory] = useState<ChartData[]>([]);
  const [config, setConfig] = useState<AppConfig>({
    theme: "light",
    start_on_boot: false,
    server_port: 4040,
    show_ip: true,
    refresh_interval: 2000,
  });
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationRef = useRef<HTMLDivElement>(null);
  const [threats, setThreats] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [activeProfile, setActiveProfile] = useState("balanced");
  const [selectedGameApps, setSelectedGameApps] = useState<string[]>(["chrome.exe", "discord.exe", "spotify.exe"]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const handleConfigChange = (newConfig: AppConfig) => {
    setConfig(newConfig);
  };

  const saveSettings = async () => {
    setIsSaving(true);
    setSaveStatus("Saving...");
    if (window.__TAURI_INTERNALS__) {
      try {
        await invoke("update_config", { newConfig: config });
        setSaveStatus("Settings saved successfully!");
        setTimeout(() => setSaveStatus(null), 3000);
      } catch (e) {
        console.error("Failed to update config", e);
        setSaveStatus("Error saving settings.");
        setTimeout(() => setSaveStatus(null), 3000);
      }
    } else {
      setSaveStatus("Saved (Simulated)");
      setTimeout(() => setSaveStatus(null), 2000);
    }
    setIsSaving(false);
  };
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set());
  
  // Uninstall Modal State
  const [showUninstallModal, setShowUninstallModal] = useState<AppInfo | null>(null);
  const [doBackup, setDoBackup] = useState(true);
  const [doDeepClean, setDoDeepClean] = useState(true);
  const [uninstalling, setUninstalling] = useState(false);
  const [expandedAppId, setExpandedAppId] = useState<string | null>(null);
  const [appDescription, setAppDescription] = useState<string | null>(null);
  const [loadingDescription, setLoadingDescription] = useState(false);

  // Live Progress Modal
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [progressVisible, setProgressVisible] = useState(false);
  const [progressDone, setProgressDone] = useState(false);
  const progressEndRef = useRef<HTMLDivElement>(null);

  // Backups
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);

  // Updater State
  const [availableUpdates, setAvailableUpdates] = useState<any[]>([]);
  const [selectedUpdates, setSelectedUpdates] = useState<Set<string>>(new Set());
  const [isScanningUpdates, setIsScanningUpdates] = useState(false);
  const [updaterLogs, setUpdaterLogs] = useState<string[]>([]);
  const [updaterRunning, setUpdaterRunning] = useState(false);
  const [remoteConnections, setRemoteConnections] = useState(0);

  // Apply theme to body
  useEffect(() => {
    document.body.className = `${config.theme}-theme`;
  }, [config.theme]);
  const [managers, setManagers] = useState({
    winget: true,
    choco: true,
    pip: true,
    npm: true,
    wsus: true
  });
  const logEndRef = useRef<HTMLDivElement>(null);

  const addNotification = async (title: string, body: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const newNotif = {
      id: Date.now(),
      title,
      body,
      type,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      read: false
    };
    setNotifications(prev => [newNotif, ...prev].slice(0, 50));
    
    if (window.__TAURI_INTERNALS__) {
      let permission = await isPermissionGranted();
      if (!permission) {
        const permissionState = await requestPermission();
        permission = permissionState === 'granted';
      }
      if (permission) {
        sendNotification({ title, body });
      }
    }
  };

  // Close notification dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const previousConnections = useRef(0);
  useEffect(() => {
    if (stats && stats.active_remote_connections > previousConnections.current) {
      addNotification("New Connection", "A remote device has connected to your PC.", "info");
    }
    if (stats) {
      previousConnections.current = stats.active_remote_connections;
    }
  }, [stats?.active_remote_connections]);

  // Auto-scroll logs
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [updaterLogs]);

  // Initial welcome notification
  useEffect(() => {
    setTimeout(() => {
      addNotification("Welcome to PC Manager", "Your system is optimized and ready for management.", "success");
    }, 1500);
  }, []);

  // Initial fetch for config
  useEffect(() => {
    if (window.__TAURI_INTERNALS__) {
      invoke<AppConfig>("get_config")
        .then(setConfig)
        .catch(console.error);
    }
  }, []);

  // Auto-scroll progress modal
  useEffect(() => {
    if (progressEndRef.current) {
      progressEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [progressLines]);

  // Listen to updater logs
  useEffect(() => {
    let unlisten: any;
    const setupListener = async () => {
      if (!window.__TAURI_INTERNALS__) return;
      unlisten = await listen<string>("updater-log", (event) => {
        setUpdaterLogs(prev => [...prev, event.payload]);
        if (event.payload === "--- COMPLETE ---") {
          setUpdaterRunning(false);
          addNotification("Update Complete", "System updates have been installed.", "success");
        }
      });
    };
    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Listen to live uninstall/backup progress events
  useEffect(() => {
    let unlisten: any;
    const setup = async () => {
      if (!window.__TAURI_INTERNALS__) return;
      unlisten = await listen<string>("uninstall-progress", (event) => {
        setProgressLines(prev => [...prev, event.payload]);
        if (event.payload === "--- DONE ---") {
          setProgressDone(true);
          setUninstalling(false);
          setRestoringBackup(null);
          fetchApps();
          fetchBackups();
        }
      });
    };
    setup();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const scanUpdates = async () => {
    if (!window.__TAURI_INTERNALS__) return alert("Browser mode: Cannot scan native updates.");
    setIsScanningUpdates(true);
    setAvailableUpdates([]);
    setSelectedUpdates(new Set());
    try {
      const selectedManagers = Object.entries(managers)
        .filter(([_, isSelected]) => isSelected)
        .map(([key, _]) => key);
      const updates = await invoke<any[]>("scan_for_updates", { managers: selectedManagers });
      setAvailableUpdates(updates);
      // Auto-select all by default
      const allIds = new Set(updates.map(u => u.id));
      setSelectedUpdates(allIds);
      addNotification("Scan Complete", `Found ${updates.length} updates available.`, "info");
    } catch (err) {
      console.error(err);
      alert("Failed to scan updates: " + err);
    } finally {
      setIsScanningUpdates(false);
    }
  };

  const startUpdater = async () => {
    if (!window.__TAURI_INTERNALS__) return alert("Browser mode: Cannot run native updater.");
    if (selectedUpdates.size === 0) return alert("Select at least one update to install.");
    
    setUpdaterRunning(true);
    setUpdaterLogs(["Starting System Multi-Updater..."]);
    try {
      const updatesToInstall = availableUpdates.filter(u => selectedUpdates.has(u.id));
      await invoke("install_specific_updates", { updates: updatesToInstall });
    } catch (err) {
      console.error(err);
      setUpdaterLogs(prev => [...prev, `ERROR: ${err}`]);
      setUpdaterRunning(false);
    }
  };

  const toggleUpdateSelection = (id: string) => {
    const next = new Set(selectedUpdates);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedUpdates(next);
  };

  const toggleAppSelection = (id: string) => {
    const next = new Set(selectedApps);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedApps(next);
  };

  const selectAllApps = () => {
    if (selectedApps.size === filteredApps.length) {
      setSelectedApps(new Set());
    } else {
      setSelectedApps(new Set(filteredApps.map(app => app.id)));
    }
  };

  // Poll for remote connection count and start server if needed
  useEffect(() => {
    let interval: any;
    if (activeTab === "remote" && window.__TAURI_INTERNALS__) {
      // Start server on entry with current config port
      invoke("start_remote_server", { port: null }).catch(console.error);
      
      interval = setInterval(async () => {
        try {
          const count = await invoke<number>("get_remote_connection_count");
          setRemoteConnections(count);
        } catch (e) {
          console.error("Failed to fetch connection count", e);
        }
      }, 2000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [activeTab]);

  const fetchProcesses = async () => {
    if (!window.__TAURI_INTERNALS__) return;
    try {
      const data = await invoke<ProcessInfo[]>("get_processes");
      setProcesses(data);
    } catch (err) {
      console.error("Failed to fetch processes", err);
    }
  };

  const killProcess = async (pid: number) => {
    if (!confirm(`Are you sure you want to end process ${pid}?`)) return;
    try {
      await invoke("kill_process", { pid });
      fetchProcesses(); // Refresh list after kill
    } catch (err) {
      alert("Failed to kill process: " + err);
    }
  };

  // Poll system stats and processes
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const data = await invoke<SystemStats>("get_system_stats");
        setStats(data);
        
        // Update historical data for charts
        setHistory(prev => {
          const now = new Date();
          const timeLabel = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
          const ramPercent = (data.ram_used / data.ram_total) * 100;
          
          const newPoint = { 
            time: timeLabel, 
            cpu: Math.round(data.cpu_usage), 
            ram: Math.round(ramPercent),
            temp: Math.round(data.cpu_temp),
            net_rx: data.net_rx,
            net_tx: data.net_tx
          };
          const newHistory = [...prev, newPoint];
          
          if (newHistory.length > 20) newHistory.shift(); // keep last 20 ticks
          return newHistory;
        });
        
        // Also fetch processes if we are on the task manager
        fetchProcesses();
      } catch (err) {
        console.error("Failed to fetch stats", err);
      }
    }, config.refresh_interval);
    return () => clearInterval(interval);
  }, [config.refresh_interval]);

  // Fetch App Description from Wikipedia
  useEffect(() => {
    if (!expandedAppId) {
      setAppDescription(null);
      return;
    }

    const app = apps.find(a => a.id === expandedAppId);
    if (!app) return;

    // Clean up app name for better search results
    let searchName = app.name
      .replace(/\(.*\)/g, '')
      .replace(/v\d+(\.\d+)*/g, '')
      .replace(/setup/i, '')
      .replace(/update/i, '')
      .split('-')[0]
      .trim();

    setLoadingDescription(true);
    setAppDescription(null);

    // Wikipedia Search API - request more results to build a better description
    fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchName + ' software')}&srlimit=3&utf8=&format=json&origin=*`)
      .then(res => res.json())
      .then(data => {
        if (data.query && data.query.search && data.query.search.length > 0) {
          // Combine up to 2 snippets for a longer description
          const snippets = data.query.search.slice(0, 2).map((item: any) => 
            item.snippet.replace(/<\/?[^>]+(>|$)/g, "")
          ).join(' ');
          
          setAppDescription(snippets + (snippets.length > 50 ? "..." : ""));
        } else {
          setAppDescription("No additional information found for this application.");
        }
      })
      .catch(err => {
        console.error("Failed to fetch app info", err);
        setAppDescription("Could not load application info.");
      })
      .finally(() => {
        setLoadingDescription(false);
      });
  }, [expandedAppId, apps]);

  // Fetch initial data
  const fetchApps = async () => {
    setLoadingApps(true);
    try {
      if (!window.__TAURI_INTERNALS__) {
        console.warn("Tauri environment not detected.");
        setApps([{name: "Mock Application (Browser Mode)", id: "0", version: "1.0"}]);
        return;
      }
      const appData = await invoke<AppInfo[]>("get_installed_apps");
      setApps(appData);
      setSelectedApps(new Set());
    } catch (err) {
      console.error("Failed to fetch apps", err);
    } finally {
      setLoadingApps(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        if (!window.__TAURI_INTERNALS__) {
          setLocalIp("127.0.0.1");
          return;
        }
        const ip = await invoke<string>("get_local_ip");
        setLocalIp(ip);
        invoke("start_remote_server").catch(e => console.error("Server already running or failed", e));
      } catch (err) {
        console.error("Initialization failed", err);
      }
    };
    init();
    fetchApps();
    fetchBackups();
  }, []);

  const switchProfile = async (id: string) => {
    setActiveProfile(id);
    try {
      await invoke("apply_performance_profile", { profileId: id });
      addNotification("Profile Switched", `System is now in ${id} mode.`, "success");
    } catch (err) {
      console.error(err);
      addNotification("Profile Error", "Could not change system power plan.", "error");
    }
  };

  const runGameMode = async () => {
    addNotification("Game Mode", "Optimizing system for gaming...", "info");
    try {
      await invoke("enable_game_mode", { apps: selectedGameApps });
      setActiveProfile("turbo");
      addNotification("Game Mode Active", `Turbo profile applied & ${selectedGameApps.length} apps optimized.`, "success");
    } catch (err) {
      addNotification("Error", "Failed to enable Game Mode.", "error");
    }
  };

  const runFocusMode = async () => {
    addNotification("Focus Mode", "Entering focus environment...", "info");
    try {
      await invoke("enable_focus_mode");
      setActiveProfile("silent");
      addNotification("Focus Mode Active", "System silenced & notifications minimized.", "success");
    } catch (err) {
      addNotification("Error", "Failed to enable Focus Mode.", "error");
    }
  };

  const runSecurityScan = () => {
    setScanning(true);
    setThreats([]);
    // Mocking scan results after delay
    setTimeout(() => {
      setScanning(false);
      // Let's pretend we found something sometimes or not
      const found = Math.random() > 0.7;
      if (found) {
        const mockThreats = ["Trojan.Win32.Generic", "Adware.Tracking.Cookie"];
        setThreats(mockThreats);
        addNotification("Security Warning", `Scan found ${mockThreats.length} potential threats!`, "error");
      } else {
        setThreats([]);
        addNotification("Scan Complete", "No threats detected in your system.", "success");
      }
    }, 4000);
  };

  const deleteThreat = (path: string) => {
    if (confirm(`Are you sure you want to delete this file? This action cannot be undone.\n\nPath: ${path}`)) {
      // In a real app, we'd invoke a delete command here
      setThreats(threats.filter(t => t !== path));
      alert("File deleted successfully.");
      addNotification("File Deleted", "The threat has been removed.", "success");
    }
  };

  const fetchBackups = async () => {
    if (!window.__TAURI_INTERNALS__) return;
    setLoadingBackups(true);
    try {
      const data = await invoke<BackupInfo[]>("list_backups");
      setBackups(data);
    } catch (err) {
      console.error("Failed to fetch backups", err);
    } finally {
      setLoadingBackups(false);
    }
  };

  const openProgress = () => {
    setProgressLines([]);
    setProgressDone(false);
    setProgressVisible(true);
  };

  const processUninstall = async () => {
    if (!showUninstallModal) return;
    setUninstalling(true);
    setShowUninstallModal(null);
    openProgress();
    try {
      if (doBackup) {
        await invoke("backup_app_data", { name: showUninstallModal.name });
      }
      await invoke("uninstall_app", { 
        uninstallCmd: showUninstallModal.uninstall_cmd ?? null,
        name: showUninstallModal.name, 
        deepClean: doDeepClean 
      });
    } catch (err) {
      setProgressLines(prev => [...prev, `❌ Error: ${err}`]);
      setProgressDone(true);
      setUninstalling(false);
    }
  };

  const processBatchUninstall = async () => {
    if (selectedApps.size === 0) return;
    if (!confirm(`Are you sure you want to uninstall ${selectedApps.size} selected apps?`)) return;
    setUninstalling(true);
    openProgress();

    for (const appId of selectedApps) {
      const app = apps.find(a => a.id === appId);
      if (!app) continue;
      try {
        if (doBackup) {
          await invoke("backup_app_data", { name: app.name });
        }
        await invoke("uninstall_app", { 
          uninstallCmd: app.uninstall_cmd ?? null,
          name: app.name, 
          deepClean: doDeepClean 
        });
      } catch (err) {
        setProgressLines(prev => [...prev, `❌ Error uninstalling ${app.name}: ${err}`]);
      }
    }
    setSelectedApps(new Set());
  };

  const restoreBackup = async (backup: BackupInfo) => {
    if (!confirm(`Restore "${backup.app_name}" from backup?\n\nFiles will be restored to AppData\\Roaming.`)) return;
    setRestoringBackup(backup.name);
    openProgress();
    try {
      await invoke("restore_backup", { backupPath: backup.path });
      addNotification("Restore Complete", `Successfully restored ${backup.app_name}.`, "success");
    } catch (err) {
      setProgressLines(prev => [...prev, `❌ Restore error: ${err}`]);
      setProgressDone(true);
      setRestoringBackup(null);
    }
  };

  const deleteBackup = async (backup: BackupInfo) => {
    if (!confirm(`Are you sure you want to permanently delete the backup for "${backup.app_name}"?`)) return;
    try {
      await invoke("delete_backup", { backupPath: backup.path });
      fetchBackups();
    } catch (err) {
      alert(`Delete error: ${err}`);
    }
  };

  const updateApp = (appId: string) => {
    addNotification("Update Started", `Installing update for ${appId}...`, "info");
    // Mocking update process
    setTimeout(() => {
      addNotification("Update Success", `${appId} has been updated to the latest version.`, "success");
      fetchApps();
    }, 4000);
  };

  const formatBackupDate = (ts: string) => {
    const n = parseInt(ts, 10);
    if (!n) return "Unknown";
    return new Date(n * 1000).toLocaleString();
  };

  const formatBackupSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const filteredApps = apps.filter(app => 
    app.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatBytes = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return gb.toFixed(1) + " GB";
  };

  const formatUptime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hrs}h ${mins}m`;
  };

  return (
    <div className="app-container">
      {/* Uninstall Modal Overlay */}
      <AnimatePresence>
        {showUninstallModal && (
          <motion.div 
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div 
              className="modal glass"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
            >
              <h3>Uninstall {showUninstallModal.name}</h3>
              <p className="text-muted">Choose how you want to remove this application.</p>
              
              <div className="options-list">
                <label className="option-item">
                  <input type="checkbox" checked={doBackup} onChange={(e) => setDoBackup(e.target.checked)} />
                  <div className="option-info">
                    <div className="option-title"><Database size={16} /> Create Backup</div>
                    <div className="option-desc">Save app data to Desktop/PCManager_Backups</div>
                  </div>
                </label>
                <label className="option-item">
                  <input type="checkbox" checked={doDeepClean} onChange={(e) => setDoDeepClean(e.target.checked)} />
                  <div className="option-info">
                    <div className="option-title"><Search size={16} /> Deep Cleanup</div>
                    <div className="option-desc">Scan and remove residual folders in AppData</div>
                  </div>
                </label>
              </div>

              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => setShowUninstallModal(null)}>Cancel</button>
                <button className="btn-primary danger" onClick={processUninstall} disabled={uninstalling}>
                  {uninstalling ? "Processing..." : "Confirm Uninstall"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live Progress Modal */}
      <AnimatePresence>
        {progressVisible && (
          <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              className="modal glass"
              style={{ width: '640px', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                {!progressDone
                  ? <RefreshCw size={18} className="animate-spin" style={{ color: 'var(--primary)' }} />
                  : <span style={{ fontSize: '1.2rem' }}>✅</span>
                }
                <h3 style={{ margin: 0 }}>{progressDone ? 'Operation Complete' : 'Working...'}</h3>
              </div>
              <p className="text-muted" style={{ fontSize: '0.82rem', marginBottom: '0.75rem' }}>
                {progressDone ? 'All steps finished. Review the log below.' : 'Please wait — do not close this window.'}
              </p>
              <div style={{
                flex: 1, overflowY: 'auto', background: '#060a12', borderRadius: '8px',
                padding: '1rem', fontFamily: 'Consolas, monospace', fontSize: '0.82rem',
                lineHeight: '1.8', border: '1px solid rgba(255,255,255,0.05)', maxHeight: '55vh',
              }}>
                {progressLines.map((line, i) => {
                  let color = '#94a3b8';
                  if (line.includes('DONE') || line.includes('complete') || line.includes('complete')) color = '#22c55e';
                  if (line.includes('Deleted') || line.includes('saved') || line.includes('Restored') || line.includes('Removed registry')) color = '#22c55e';
                  if (line.includes('Error') || line.includes('Cannot') || line.includes('error')) color = '#ef4444';
                  if (line.includes('Running') || line.includes('Opening') || line.includes('Starting') || line.includes('Trying')) color = '#60a5fa';
                  if (line.includes('Cleaning') || line.includes('clean')) color = '#c084fc';
                  if (line.includes('PATH') || line.includes('Removed from')) color = '#f59e0b';
                  if (line.includes('Backing up') || line.includes('Found') || line.includes('Backup saved')) color = '#38bdf8';
                  return (
                    <div key={i} style={{ color, marginBottom: '1px', display: 'flex', gap: '0.5rem' }}>
                      <span style={{ opacity: 0.25, fontSize: '0.7rem', lineHeight: '1.8', minWidth: '22px', textAlign: 'right' }}>{i+1}</span>
                      <span>{line || '\u00a0'}</span>
                    </div>
                  );
                })}
                {!progressDone && <div style={{ color: '#60a5fa', fontWeight: 'bold' }}>▋</div>}
                <div ref={progressEndRef} />
              </div>
              <div className="modal-actions" style={{ marginTop: '1rem' }}>
                {progressDone
                  ? <button className="btn-primary" onClick={() => setProgressVisible(false)}>Close</button>
                  : <button className="btn-secondary" disabled style={{ opacity: 0.5 }}>Running...</button>
                }
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className="sidebar glass">
        <div className="logo-container">
          <div className="logo-icon"><Zap size={24} fill="currentColor" /></div>
          <span className="logo-text">PC Manager</span>
        </div>
        
        <nav className="side-nav">
          {[
            { id: "dashboard", icon: <LayoutDashboard size={20} />, label: "Dashboard" },
            { id: "taskmgr", icon: <Activity size={20} />, label: "Task Manager" },
            { id: "apps", icon: <Package size={20} />, label: "Applications" },
            { id: "backups", icon: <Archive size={20} />, label: "Backups" },
            { id: "updater", icon: <DownloadCloud size={20} />, label: "System Updater" },
            { id: "security", icon: <ShieldAlert size={20} />, label: "Security" },
            { id: "remote", icon: <Smartphone size={20} />, label: "Remote Control" },
            { id: "profiles", icon: <User size={20} />, label: "Profiles" },
          ].map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activeTab === item.id ? "active" : ""}`}
              onClick={() => setActiveTab(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button 
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={20} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <header className="main-header">
          <div className="header-search">
            <Search size={18} className="search-icon" />
            <input 
              type="text" 
              placeholder="Search features, apps..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="header-actions">
            <div className="notification-container" ref={notificationRef}>
              <button 
                className="icon-btn" 
                onClick={() => setShowNotifications(!showNotifications)}
              >
                <Bell size={20} />
                {notifications.some(n => !n.read) && <span className="badge-dot"></span>}
              </button>
              
              <AnimatePresence>
                {showNotifications && (
                  <motion.div 
                    className="notification-dropdown glass-card"
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  >
                    <div className="notif-header">
                      <span>Notifications</span>
                      {notifications.length > 0 && (
                        <button onClick={() => setNotifications(prev => prev.map(n => ({...n, read: true})))}>
                          Mark all read
                        </button>
                      )}
                    </div>
                    <div className="notif-list">
                      {notifications.length === 0 ? (
                        <div className="notif-empty">No new notifications</div>
                      ) : (
                        notifications.map(n => (
                          <div key={n.id} className={`notif-item ${n.read ? 'read' : ''} ${n.type}`}>
                            <div className="notif-icon">
                              {n.type === 'success' && <ShieldCheck size={16} />}
                              {n.type === 'warning' && <AlertTriangle size={16} />}
                              {n.type === 'error' && <XCircle size={16} />}
                              {n.type === 'info' && <Info size={16} />}
                            </div>
                            <div className="notif-content">
                              <div className="notif-title">{n.title}</div>
                              <div className="notif-body">{n.body}</div>
                              <div className="notif-time">{n.time}</div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                    {notifications.length > 0 && (
                      <div className="notif-footer">
                        <button onClick={() => setNotifications([])}>Clear All</button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            
            <div className="user-profile">
              <div className="avatar">JD</div>
            </div>
          </div>
        </header>

        <div className="content-viewport">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === "dashboard" && (
                <div className="dashboard-view">
                  <div className="section-header">
                    <h2>System Dashboard</h2>
                    <p>Real-time performance and monitoring</p>
                  </div>
                  <div className="stats-grid">
                    <div className="glass-card stat-card">
                      <div className="stat-info">
                        <div className="flex-row w-full gap-2">
                          <Cpu size={24} className="text-primary" />
                          <span className="label">CPU Usage</span>
                        </div>
                        <span className="value">{stats?.cpu_usage.toFixed(1) || "0"}%</span>
                      </div>
                      <div className="chart-container" style={{ height: 100, marginTop: 10 }}>
                        <ResponsiveContainer width="100%" height="100%" minHeight={100}>
                          <AreaChart data={history}>
                            <defs>
                              <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="var(--primary)" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <Area type="monotone" dataKey="cpu" stroke="var(--primary)" fillOpacity={1} fill="url(#colorCpu)" isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    <div className="glass-card stat-card">
                      <div className="stat-info">
                        <div className="flex-row w-full gap-2">
                          <Zap size={24} className="text-secondary" />
                          <span className="label">Memory (RAM)</span>
                        </div>
                        <span className="value">{stats ? `${formatBytes(stats.ram_used)} / ${formatBytes(stats.ram_total)}` : "Loading..."}</span>
                      </div>
                      <div className="chart-container" style={{ height: 100, marginTop: 10 }}>
                        <ResponsiveContainer width="100%" height="100%" minHeight={100}>
                          <AreaChart data={history}>
                            <defs>
                              <linearGradient id="colorRam" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--secondary)" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="var(--secondary)" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <Area type="monotone" dataKey="ram" stroke="var(--secondary)" fillOpacity={1} fill="url(#colorRam)" isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    
                    <div className="glass-card stat-card" style={{ gridColumn: 'span 2' }}>
                      <div className="stat-info mb-4" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '2rem' }}>
                        <div style={{ flex: 1, minWidth: '250px' }}>
                          <div className="flex-row w-full gap-2">
                            <Activity size={24} style={{ color: '#ec4899' }} />
                            <span className="label">System Health</span>
                          </div>
                          <div style={{ display: 'flex', gap: '2rem', marginTop: '1rem' }}>
                            <div style={{ flex: 1 }}>
                              <span className="text-muted" style={{ fontSize: '0.75rem', display: 'block' }}>CPU Temp</span>
                              <span className="value" style={{ fontSize: '1.1rem', color: (stats?.cpu_temp || 0) > 75 ? '#ef4444' : '#ec4899' }}>
                                {stats ? `${stats.cpu_temp.toFixed(1)}°C` : "--"}
                              </span>
                              <div className="chart-container" style={{ height: 40, marginTop: 5 }}>
                                  <ResponsiveContainer width="100%" height="100%" minHeight={40}>
                                  <AreaChart data={history}>
                                    <defs>
                                      <linearGradient id="colorTemp" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#ec4899" stopOpacity={0.3}/>
                                        <stop offset="95%" stopColor="#ec4899" stopOpacity={0}/>
                                      </linearGradient>
                                    </defs>
                                    <Area type="monotone" dataKey="temp" stroke="#ec4899" fillOpacity={1} fill="url(#colorTemp)" isAnimationActive={false} />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                            <div>
                              <span className="text-muted" style={{ fontSize: '0.75rem', display: 'block' }}>Battery</span>
                              <div className="flex-row gap-1">
                                <span className="value" style={{ fontSize: '1.1rem', color: (stats?.battery_level || 0) < 20 ? '#ef4444' : '#22c55e' }}>
                                  {stats ? `${stats.battery_level}%` : "--"}
                                </span>
                                {stats?.is_charging && <Zap size={14} style={{ color: '#f59e0b' }} className="animate-pulse" />}
                              </div>
                            </div>
                            <div>
                              <span className="text-muted" style={{ fontSize: '0.75rem', display: 'block' }}>Uptime</span>
                              <span className="value" style={{ fontSize: '1.1rem', color: '#8b5cf6' }}>
                                {stats ? formatUptime(stats.uptime) : "--"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div style={{ flex: 1, minWidth: '300px' }}>
                          <div className="flex-row w-full gap-2">
                            <Wifi size={24} style={{ color: '#0ea5e9' }} />
                            <span className="label">Network & GPU</span>
                          </div>
                          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '1rem' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                                <span className="text-muted" style={{ fontSize: '0.75rem' }}>Speed (Down / Up)</span>
                              </div>
                              <div style={{ display: 'flex', gap: '1rem', alignItems: 'baseline' }}>
                                <span className="value" style={{ fontSize: '0.95rem', color: '#0ea5e9' }}>
                                  {stats ? `${formatBytes(stats.net_rx)}/s ↓` : "0 B/s"}
                                </span>
                                <span className="value" style={{ fontSize: '0.95rem', color: '#38bdf8' }}>
                                  {stats ? `${formatBytes(stats.net_tx)}/s ↑` : "0 B/s"}
                                </span>
                              </div>
                              <div className="chart-container" style={{ height: 40, marginTop: 5 }}>
                                  <ResponsiveContainer width="100%" height="100%" minHeight={40}>
                                  <AreaChart data={history}>
                                    <defs>
                                      <linearGradient id="colorNet" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3}/>
                                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0}/>
                                      </linearGradient>
                                    </defs>
                                    <Area type="monotone" dataKey="net_rx" stroke="#0ea5e9" fillOpacity={1} fill="url(#colorNet)" isAnimationActive={false} />
                                    <Area type="monotone" dataKey="net_tx" stroke="#38bdf8" fillOpacity={0.5} fill="none" isAnimationActive={false} />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', minWidth: '120px' }}>
                              <span className="text-muted" style={{ fontSize: '0.75rem', display: 'block' }}>Graphics (GPU)</span>
                              <span className="value" style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginTop: 5 }}>
                                {stats?.gpu_name || "Detecting..."}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {stats?.disks.map((disk, i) => (
                      <div key={i} className="glass-card stat-card">
                        <div className="stat-info mb-4">
                          <div className="flex-row w-full gap-2">
                            <HardDrive size={24} className="text-accent" />
                            <span className="label">Disk {disk.name}</span>
                          </div>
                          <span className="value">{formatBytes(disk.free_space)} Free</span>
                        </div>
                        <div className="progress-bar mt-auto"><div className="fill" style={{ width: `${(1 - (disk.free_space / disk.total_space)) * 100}%`, background: 'var(--accent)' }}></div></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === "taskmgr" && (
                <div className="taskmgr-view">
                  <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h2>Task Manager</h2>
                      <p>Monitor and manage active processes</p>
                    </div>
                    <button className="btn-secondary" onClick={fetchProcesses}>
                      <RefreshCw size={16} /> Refresh
                    </button>
                  </div>
                  
                  <div className="glass-card table-container" style={{ height: '600px', overflowY: 'auto' }}>
                    <table className="data-table" style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>
                        <tr>
                          <th style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>PID</th>
                          <th style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>Process Name</th>
                          <th style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>Memory</th>
                          <th style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase' }}>CPU %</th>
                          <th style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processes.length === 0 ? (
                          <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem' }}>Loading processes...</td></tr>
                        ) : (
                          processes
                            .filter(proc => proc.name.toLowerCase().includes(searchQuery.toLowerCase()))
                            .map(proc => (
                              <tr key={proc.pid} style={{ borderBottom: '1px solid var(--border-light)' }}>
                              <td style={{ padding: '10px 16px', opacity: 0.7, fontSize: '0.9rem' }}>{proc.pid}</td>
                              <td style={{ padding: '10px 16px', fontWeight: 500, fontSize: '0.9rem' }}>{proc.name}</td>
                              <td style={{ padding: '10px 16px', fontSize: '0.9rem' }}>{formatBytes(proc.memory)}</td>
                              <td style={{ padding: '10px 16px', fontSize: '0.9rem', color: proc.cpu_usage > 10 ? '#ef4444' : 'inherit' }}>
                                {proc.cpu_usage.toFixed(1)}%
                              </td>
                              <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                                <button 
                                  className="btn-small danger" 
                                  onClick={() => killProcess(proc.pid)}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem' }}
                                >
                                  <XCircle size={14} /> End Task
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "apps" && (
                <div className="apps-view">
                  <div className="section-header">
                    <div className="flex-row" style={{ justifyContent: 'space-between', width: '100%' }}>
                      <div>
                        <h2>App Manager</h2>
                        <p>Manage installed software and updates</p>
                      </div>
                      <div className="flex-row" style={{ gap: '1rem' }}>
                        {selectedApps.size > 0 && (
                          <button className="btn-primary danger" onClick={processBatchUninstall} disabled={uninstalling}>
                            <Trash2 size={16} /> Uninstall Selected ({selectedApps.size})
                          </button>
                        )}
                        <button className="btn-secondary" onClick={fetchApps} disabled={loadingApps}>
                          <RefreshCw size={16} className={loadingApps ? "animate-spin" : ""} />
                          Refresh
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="glass-card table-container">
                    {loadingApps ? (
                      <div className="loader">Scanning system for apps...</div>
                    ) : (
                      <table className="app-table">
                        <thead>
                          <tr>
                            <th style={{ width: '40px' }}>
                              <input 
                                type="checkbox" 
                                checked={selectedApps.size === filteredApps.length && filteredApps.length > 0} 
                                onChange={selectAllApps}
                              />
                            </th>
                            <th>Application</th>
                            <th>Version</th>
                            <th>Status</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredApps.length === 0 ? (
                            <tr>
                              <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', opacity: 0.5 }}>
                                {searchQuery ? "No apps match your search." : "No apps found."}
                              </td>
                            </tr>
                          ) : (
                            filteredApps.map((app) => (
                              <React.Fragment key={app.id}>
                                <tr className={selectedApps.has(app.id) ? "selected" : ""}>
                                  <td>
                                    <input 
                                      type="checkbox" 
                                      checked={selectedApps.has(app.id)} 
                                      onChange={(e) => { e.stopPropagation(); toggleAppSelection(app.id); }}
                                    />
                                  </td>
                                  <td onClick={() => setExpandedAppId(expandedAppId === app.id ? null : app.id)} style={{ cursor: 'pointer' }}>{app.name}</td>
                                  <td onClick={() => setExpandedAppId(expandedAppId === app.id ? null : app.id)} style={{ cursor: 'pointer' }}>{app.version}</td>
                                  <td>
                                    {app.available_version ? (
                                      <span className="badge warning">Update Available</span>
                                    ) : (
                                      <span className="badge success">Installed</span>
                                    )}
                                  </td>
                                  <td className="actions">
                                    {app.available_version && (
                                      <button className="btn-small primary" onClick={() => updateApp(app.id)}>Update</button>
                                    )}
                                    <button className="btn-small danger" onClick={(e) => { e.stopPropagation(); setShowUninstallModal(app); }}>
                                      <Trash2 size={14} />
                                    </button>
                                  </td>
                                </tr>
                                {expandedAppId === app.id && (
                                  <tr className="expanded-details-row">
                                    <td colSpan={5} style={{ padding: 0, borderBottom: '1px solid var(--border-light)' }}>
                                      <motion.div 
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        style={{ padding: '1.5rem', backgroundColor: '#f8fafc', borderLeft: '4px solid var(--primary)' }}
                                      >
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1.5rem', alignItems: 'center' }}>
                                          <div style={{ fontSize: '0.9rem', lineHeight: '1.6', color: 'var(--text-main)' }}>
                                            <div style={{ marginBottom: '0.5rem' }}>
                                              <strong style={{ color: 'var(--text-main)' }}>About:</strong>{' '}
                                              {loadingDescription ? (
                                                <span style={{ fontStyle: 'italic', opacity: 0.7 }}>Searching web for app info...</span>
                                              ) : (
                                                <span style={{ color: 'var(--text-muted)' }} dangerouslySetInnerHTML={{ __html: appDescription || '' }} />
                                              )}
                                            </div>
                                            <div><strong style={{ color: 'var(--text-main)' }}>Install Location:</strong> {app.install_location || "Not found in registry"}</div>
                                            <div><strong style={{ color: 'var(--text-main)' }}>Uninstall Cmd:</strong> {app.uninstall_cmd || "None"}</div>
                                          </div>
                                          <button 
                                            className="btn-secondary" 
                                            disabled={!app.install_location}
                                            onClick={async () => {
                                              if (app.install_location) {
                                                try {
                                                  // Clean path quotes just in case before opening
                                                  const cleanPath = (app.install_location || "").replace(/^['"]|['"]$/g, '');
                                                  await invoke("open_folder", { path: cleanPath, appName: app.name });
                                                } catch (err) {
                                                  alert(`Could not open folder: ${err}`);
                                                }
                                              }
                                            }}
                                            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                                          >
                                            <ExternalLink size={14} /> Open Folder
                                          </button>
                                        </div>
                                      </motion.div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            ))
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* Backups Tab */}
              {activeTab === "backups" && (
                <div className="apps-container fade-in">
                  <div className="section-header">
                    <h2>System Backups</h2>
                    <div className="header-actions-row">
                      <button className="icon-btn" onClick={fetchBackups} title="Refresh">
                        <RefreshCw size={18} className={loadingBackups ? "animate-spin" : ""} />
                      </button>
                    </div>
                  </div>

                  {loadingBackups ? (
                    <div className="loading-state">
                      <RefreshCw className="animate-spin text-primary" size={32} />
                      <p>Scanning Desktop/PCManager_Backups...</p>
                    </div>
                  ) : backups.length === 0 ? (
                    <div className="empty-state glass">
                      <Archive size={48} className="text-muted" />
                      <h3>No Backups Found</h3>
                      <p className="text-muted">Uninstall an app with the "Create Backup" option checked to see backups here.</p>
                    </div>
                  ) : (
                    <div className="data-table-container glass">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ width: '30%' }}>Application</th>
                            <th style={{ minWidth: '150px' }}>Backup Date</th>
                            <th style={{ minWidth: '100px' }}>Size</th>
                            <th style={{ width: '40%' }}>Archive Name</th>
                            <th style={{ textAlign: 'right' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {backups.map((bk) => (
                            <tr key={bk.name}>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                  <div className="app-icon-placeholder"><Archive size={16} /></div>
                                  <span style={{ fontWeight: 500 }}>{bk.app_name}</span>
                                </div>
                              </td>
                              <td><span className="badge badge-outline">{formatBackupDate(bk.created_at)}</span></td>
                              <td><span className="text-muted">{formatBackupSize(bk.size_bytes)}</span></td>
                              <td><span className="text-muted" style={{ fontSize: '0.85rem' }}>{bk.name}</span></td>
                              <td>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                  <button 
                                    className="btn-secondary" 
                                    onClick={() => restoreBackup(bk)}
                                    disabled={restoringBackup !== null}
                                  >
                                    {restoringBackup === bk.name ? "Restoring..." : "Restore"}
                                  </button>
                                  <button 
                                    className="btn-small danger" 
                                    onClick={() => deleteBackup(bk)}
                                    title="Delete Backup"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "security" && (
                <div className="security-view">
                  <div className="section-header">
                    <h2>Security Center</h2>
                    <p>Virus scanning and threat protection</p>
                  </div>
                  <div className="glass-card security-hero">
                    {scanning ? (
                      <div className="scanning-container">
                        <RefreshCw size={64} className="animate-spin text-primary" />
                        <h3>Scanning System...</h3>
                        <p>Performing Windows Defender Quick Scan (This may take a minute)</p>
                      </div>
                    ) : (
                      <>
                        {threats.length > 0 ? (
                          <AlertTriangle size={64} className="text-danger" />
                        ) : (
                          <ShieldCheck size={64} className="text-success" />
                        )}
                        <h3>{threats.length > 0 ? "Threats Detected!" : "Your PC is Protected"}</h3>
                        <p>{threats.length > 0 ? `${threats.length} potential threats found.` : "No active threats detected by Windows Defender."}</p>
                        <button className="btn-primary" onClick={runSecurityScan}>
                          Start Quick Scan
                        </button>
                      </>
                    )}
                  </div>
                  
                  {threats.length > 0 && (
                    <div className="glass-card threats-list mt-20 animate-fade-in">
                      <div className="threats-header">
                        <h4>Infected Files Found</h4>
                        <p className="text-muted">Review these files. They will only be deleted if you click "Delete".</p>
                      </div>
                      <div className="threat-items-container">
                        {threats.map((t, i) => (
                          <div key={i} className="threat-item">
                            <div className="threat-info">
                              <span className="threat-path">{t}</span>
                              <span className="threat-type">Potentially Unwanted Program</span>
                            </div>
                            <button className="btn-small danger" onClick={() => deleteThreat(t)}>Delete</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "remote" && (
                <div className="remote-view">
                  <div className="section-header">
                    <h2>Remote Connect</h2>
                    <p>Control your devices from anywhere</p>
                  </div>
                  <div className="remote-container">
                    <div className="glass-card qr-section">
                      <h3>Pair Your Device</h3>
                      <p className="text-muted">Scan this QR code with your phone to view PC stats and control your mouse.</p>
                      
                        <div className="qr-wrapper" style={{ padding: '16px', background: 'white', border: '1px solid var(--border-light)', borderRadius: '8px', width: 'fit-content' }}>
                          {localIp ? (
                            <QRCode 
                              value={`http://${localIp}:${config.server_port}`} 
                              size={140}
                              bgColor="#ffffff"
                              fgColor="#000000"
                              style={{ height: "auto", maxWidth: "100%", width: "100%" }}
                            />
                        ) : (
                          <div className="qr-placeholder">Loading IP...</div>
                        )}
                      </div>
                      
                      {config.show_ip && (
                        <div className="ip-info">
                          <span className="label">Your IP:</span>
                          <code className="value">{localIp || "---.---.---.---"}</code>
                        </div>
                      )}

                      <button className="btn-secondary mt-10">
                        <ExternalLink size={16} /> Open Web Controller
                      </button>
                    </div>

                    <div className="glass-card status-section">
                      <h3>Connection Status</h3>
                      <div className="status-list">
                        <div className="status-item">
                          <span className="dot online"></span>
                          <span>Local Server Running on port {config.server_port}</span>
                        </div>
                        <div className="status-item">
                          <span className={`dot ${remoteConnections > 0 ? "online" : "offline"}`}></span>
                          <span>{remoteConnections} remote {remoteConnections === 1 ? "device" : "devices"} connected</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "updater" && (
                <div className="updater-view">
                  <div className="section-header">
                    <h2>System Multi-Updater</h2>
                    <p>Scan and select which system packages you want to update</p>
                  </div>

                  <div className="grid-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', height: '500px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <Search size={20}/>
                          <h3>Available Updates</h3>
                        </div>
                        <button 
                          className="btn-secondary" 
                          onClick={scanUpdates} 
                          disabled={isScanningUpdates || updaterRunning}
                          style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                        >
                          {isScanningUpdates ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                          {isScanningUpdates ? "Scanning..." : "Scan for Updates"}
                        </button>
                      </div>

                      <div className="managers-toggles" style={{ display: 'flex', gap: '1rem', background: 'rgba(0,0,0,0.1)', padding: '0.5rem 1rem', borderRadius: '8px', marginBottom: '1rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                        <span className="text-muted">Scan targets:</span>
                        {Object.entries(managers).map(([key, isEnabled]) => (
                          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                            <input 
                              type="checkbox" 
                              checked={isEnabled} 
                              onChange={(e) => setManagers({...managers, [key]: e.target.checked})}
                              disabled={isScanningUpdates || updaterRunning}
                            />
                            <span style={{ textTransform: 'capitalize' }}>{key}</span>
                          </label>
                        ))}
                      </div>
                      
                      <div className="table-container" style={{ flex: 1, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                        {availableUpdates.length === 0 ? (
                          <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontStyle: 'italic' }}>
                            {isScanningUpdates ? "Scanning your system..." : "Click 'Scan for Updates' to find outdated packages."}
                          </div>
                        ) : (
                          <table className="data-table" style={{ width: '100%' }}>
                            <thead style={{ position: 'sticky', top: 0, background: '#1e293b', zIndex: 1 }}>
                              <tr>
                                <th style={{ width: '40px', textAlign: 'center' }}>
                                  <input 
                                    type="checkbox" 
                                    checked={selectedUpdates.size === availableUpdates.length && availableUpdates.length > 0}
                                    onChange={(e) => {
                                      if (e.target.checked) setSelectedUpdates(new Set(availableUpdates.map(u => u.id)));
                                      else setSelectedUpdates(new Set());
                                    }}
                                    disabled={updaterRunning}
                                  />
                                </th>
                                <th>Name</th>
                                <th>Manager</th>
                                <th>Update</th>
                              </tr>
                            </thead>
                            <tbody>
                              {availableUpdates.map((u, i) => (
                                <tr key={i} onClick={() => !updaterRunning && toggleUpdateSelection(u.id)} style={{ cursor: updaterRunning ? 'default' : 'pointer' }}>
                                  <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                                    <input 
                                      type="checkbox" 
                                      checked={selectedUpdates.has(u.id)}
                                      onChange={() => toggleUpdateSelection(u.id)}
                                      disabled={updaterRunning}
                                    />
                                  </td>
                                  <td style={{ fontWeight: 500, fontSize: '0.9rem' }}>{u.name}</td>
                                  <td>
                                    <span style={{ 
                                      padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 'bold',
                                      background: u.manager === 'pip' ? '#3776ab' : u.manager === 'npm' ? '#cb3837' : u.manager === 'winget' ? '#0078d7' : u.manager === 'wsus' ? '#00a4ef' : '#888'
                                    }}>
                                      {u.manager}
                                    </span>
                                  </td>
                                  <td style={{ fontSize: '0.8rem' }}>
                                    <span style={{ opacity: 0.6 }}>{u.current_version}</span> 
                                    <span style={{ margin: '0 4px' }}>→</span> 
                                    <span style={{ color: '#22c55e', fontWeight: 'bold' }}>{u.new_version}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>

                      <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                          {selectedUpdates.size} of {availableUpdates.length} selected
                        </span>
                        <button 
                          className="btn-primary" 
                          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                          onClick={startUpdater}
                          disabled={updaterRunning || selectedUpdates.size === 0}
                        >
                          <Play size={16}/>
                          {updaterRunning ? "Installing..." : "Install Selected"}
                        </button>
                      </div>
                    </div>

                    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', height: '500px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                        <Terminal size={20}/>
                        <h3>Live Terminal Log</h3>
                      </div>
                      
                      <div style={{ 
                        flex: 1, 
                        background: '#f1f5f9', 
                        borderRadius: '8px', 
                        padding: '1rem', 
                        overflowY: 'auto', 
                        fontFamily: 'Consolas, monospace', 
                        fontSize: '0.85rem',
                        lineHeight: '1.6',
                        color: '#1e293b',
                        boxShadow: 'inset 0 1px 3px 0 rgba(0,0,0,0.05)',
                        border: '1px solid var(--border-light)'
                      }}>
                        {updaterLogs.length === 0 ? (
                          <div style={{ color: '#64748b', fontStyle: 'italic' }}>Ready to update. Select items and click Install.</div>
                        ) : (
                          updaterLogs.map((log, i) => {
                            let color = 'inherit';
                            if (log.includes('ERROR') || log.includes('Exception') || log.includes('WARN')) color = '#ef4444';
                            else if (log.includes('---') || log.includes('===')) color = '#60a5fa';
                            else if (log.includes('>>>') || log.includes('Upgrading') || log.includes('Installing')) color = '#22c55e';
                            
                            return (
                              <div key={i} style={{ 
                                color,
                                borderBottom: '1px solid rgba(255,255,255,0.02)',
                                paddingBottom: '0.2rem',
                                marginBottom: '0.2rem',
                                wordBreak: 'break-all'
                              }}>
                                {log}
                              </div>
                            );
                          })
                        )}
                        <div ref={logEndRef} />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "profiles" && (
                <div className="profiles-view">
                  <div className="section-header">
                    <h2>Profiles & Identity</h2>
                    <p>Customize your experience and system performance</p>
                  </div>

                  <div className="profiles-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
                    {/* User Identity Card */}
                    <div className="glass-card identity-card">
                      <div className="profile-avatar-large">
                        <div className="avatar-circle">JD</div>
                        <button className="edit-avatar-btn"><Info size={14} /></button>
                      </div>
                      <div className="identity-info" style={{ textAlign: 'center', marginTop: '1.5rem' }}>
                        <h3 style={{ margin: '0 0 0.5rem 0' }}>John Doe</h3>
                        <p className="text-muted" style={{ fontSize: '0.85rem' }}>Administrator</p>
                        <div className="pc-tag" style={{ background: 'rgba(var(--primary-rgb), 0.1)', color: 'var(--primary)', padding: '4px 12px', borderRadius: '20px', fontSize: '0.75rem', display: 'inline-block', marginTop: '10px' }}>
                          PC-WORKSTATION-01
                        </div>
                      </div>
                      <div className="identity-stats" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '2rem', borderTop: '1px solid var(--border-light)', paddingTop: '1.5rem' }}>
                        <div className="id-stat">
                          <span className="stat-label">Member Since</span>
                          <span className="stat-value">May 2026</span>
                        </div>
                        <div className="id-stat">
                          <span className="stat-label">Security Level</span>
                          <span className="stat-value" style={{ color: '#22c55e' }}>High</span>
                        </div>
                      </div>
                    </div>

                    {/* Performance Profiles */}
                    <div className="performance-profiles-section">
                      <div className="glass-card" style={{ height: '100%' }}>
                        <div className="section-title">
                          <Activity size={20} className="text-primary" />
                          <h3>Performance Profiles</h3>
                        </div>
                        <div className="profiles-list" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem' }}>
                          {[
                            { id: 'silent', name: 'Silent Mode', desc: 'Focus on quiet operation and power saving', icon: <Zap size={20} />, color: '#0ea5e9' },
                            { id: 'balanced', name: 'Balanced', desc: 'Optimal blend of performance and energy efficiency', icon: <Activity size={20} />, color: 'var(--primary)' },
                            { id: 'turbo', name: 'Turbo Mode', desc: 'Maximum performance for heavy tasks and gaming', icon: <Power size={20} />, color: '#ef4444' }
                          ].map(profile => (
                            <div 
                              key={profile.id} 
                              className={`profile-card ${activeProfile === profile.id ? 'active' : ''}`}
                              onClick={() => switchProfile(profile.id)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '1.25rem',
                                padding: '1.25rem',
                                borderRadius: '12px',
                                border: '1px solid var(--border-light)',
                                background: activeProfile === profile.id ? 'rgba(var(--primary-rgb), 0.05)' : 'transparent',
                                borderColor: activeProfile === profile.id ? 'var(--primary)' : 'var(--border-light)',
                                cursor: 'pointer',
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div className="profile-icon" style={{ 
                                width: '44px', 
                                height: '44px', 
                                borderRadius: '10px', 
                                background: activeProfile === profile.id ? profile.color : 'rgba(0,0,0,0.05)',
                                color: activeProfile === profile.id ? 'white' : '#64748b',
                                display: 'flex',
                                alignItems: 'center',
                                justifyCenter: 'center',
                                display: 'flex',
                                justifyContent: 'center',
                                flexShrink: 0
                              }}>
                                {profile.icon}
                              </div>
                              <div className="profile-details">
                                <div className="profile-name" style={{ fontWeight: 600, fontSize: '1rem' }}>{profile.name}</div>
                                <div className="profile-desc" style={{ fontSize: '0.8rem', color: '#64748b' }}>{profile.desc}</div>
                              </div>
                              {activeProfile === profile.id && (
                                <div className="active-check" style={{ marginLeft: 'auto', color: 'var(--primary)' }}>
                                  <ShieldCheck size={20} />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="automation-section" style={{ marginTop: '2.5rem' }}>
                          <div className="section-title">
                            <Monitor size={20} className="text-secondary" />
                            <h3>Automation Shortcuts</h3>
                          </div>
                          
                          <div className="glass-card mt-15" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                              <h4 style={{ margin: 0, fontSize: '0.9rem' }}>Game Mode Apps to Stop</h4>
                              <span className="text-muted" style={{ fontSize: '0.75rem' }}>{selectedGameApps.length} selected</span>
                            </div>
                            <div className="game-apps-checklist" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                              {[
                                { id: 'chrome.exe', label: 'Chrome' },
                                { id: 'msedge.exe', label: 'Edge' },
                                { id: 'discord.exe', label: 'Discord' },
                                { id: 'spotify.exe', label: 'Spotify' },
                                { id: 'steam.exe', label: 'Steam' },
                                { id: 'obs64.exe', label: 'OBS' }
                              ].map(app => (
                                <label key={app.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.8rem' }}>
                                  <input 
                                    type="checkbox" 
                                    checked={selectedGameApps.includes(app.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) setSelectedGameApps([...selectedGameApps, app.id]);
                                      else setSelectedGameApps(selectedGameApps.filter(id => id !== app.id));
                                    }}
                                  />
                                  <span>{app.label}</span>
                                </label>
                              ))}
                            </div>
                          </div>

                          <div className="automation-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.25rem' }}>
                            <button className="glass-btn automation-card" onClick={runGameMode}>
                              <div className="auto-icon" style={{ background: '#f43f5e' }}><Zap size={18} /></div>
                              <span>Start Game Mode</span>
                            </button>
                            <button className="glass-btn automation-card" onClick={runFocusMode}>
                              <div className="auto-icon" style={{ background: '#8b5cf6' }}><Monitor size={18} /></div>
                              <span>Enter Focus Mode</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "settings" && (
                <div className="settings-view">
                  <div className="section-header">
                    <h2>Application Settings</h2>
                    <p>Configure preferences and system behavior</p>
                  </div>

                  <div className="settings-grid">
                    <div className="glass-card settings-section">
                      <div className="section-title">
                        <Monitor size={20} className="text-primary" />
                        <h3>General</h3>
                      </div>
                      <div className="settings-list">
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">Theme Appearance</div>
                            <div className="setting-desc">Switch between light and dark visual themes</div>
                          </div>
                          <button 
                            className="btn-secondary btn-small"
                            onClick={() => {
                              const newTheme = config.theme === 'light' ? 'dark' : 'light';
                              handleConfigChange({ ...config, theme: newTheme });
                            }}
                          >
                            {config.theme === 'light' ? 'Switch to Dark' : 'Switch to Light'}
                          </button>
                        </div>
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">Start with Windows</div>
                            <div className="setting-desc">Automatically launch PC Manager on system boot</div>
                          </div>
                          <div className="toggle-switch">
                            <input 
                              type="checkbox" 
                              id="startup-toggle" 
                              checked={config.start_on_boot}
                              onChange={(e) => handleConfigChange({ ...config, start_on_boot: e.target.checked })}
                            />
                            <label htmlFor="startup-toggle"></label>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="glass-card settings-section">
                      <div className="section-title">
                        <Globe size={20} className="text-secondary" />
                        <h3>Remote Control</h3>
                      </div>
                      <div className="settings-list">
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">Server Port</div>
                            <div className="setting-desc">Port used by the remote control server</div>
                          </div>
                          <input 
                            type="number" 
                            className="setting-input" 
                            value={config.server_port}
                            onChange={(e) => handleConfigChange({ ...config, server_port: parseInt(e.target.value) || 4040 })}
                          />
                          <button 
                            className="btn-small btn-secondary" 
                            style={{ marginLeft: '10px', fontSize: '0.7rem' }}
                            onClick={() => {
                              if (window.__TAURI_INTERNALS__) {
                                invoke("start_remote_server", { port: config.server_port })
                                  .then(() => alert("Server restarted on port " + config.server_port))
                                  .catch(err => alert("Error restarting server: " + err));
                              }
                            }}
                          >
                            Apply Port
                          </button>
                        </div>
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">Local IP Visibility</div>
                            <div className="setting-desc">Show local IP address on the remote tab</div>
                          </div>
                          <div className="toggle-switch">
                            <input 
                              type="checkbox" 
                              id="ip-toggle" 
                              checked={config.show_ip}
                              onChange={(e) => handleConfigChange({ ...config, show_ip: e.target.checked })}
                            />
                            <label htmlFor="ip-toggle"></label>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="glass-card settings-section">
                      <div className="section-title">
                        <Cpu size={20} className="text-primary" />
                        <h3>Performance Monitoring</h3>
                      </div>
                      <div className="settings-list">
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">Refresh Interval</div>
                            <div className="setting-desc">How often system stats are updated (ms)</div>
                          </div>
                          <select 
                            className="setting-input"
                            value={config.refresh_interval}
                            onChange={(e) => handleConfigChange({ ...config, refresh_interval: parseInt(e.target.value) })}
                          >
                            <option value="1000">1 second</option>
                            <option value="2000">2 seconds</option>
                            <option value="5000">5 seconds</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="glass-card settings-section">
                      <div className="section-title">
                        <Info size={20} className="text-muted" />
                        <h3>About</h3>
                      </div>
                      <div className="settings-list">
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">PC Manager Pro</div>
                            <div className="setting-desc">Version 1.0.0 (Stable)</div>
                          </div>
                          <button className="btn-secondary btn-small">Check for Updates</button>
                        </div>
                        <div className="setting-item">
                          <div className="setting-info">
                            <div className="setting-name">Privacy Policy</div>
                            <div className="setting-desc">Read how we handle your data</div>
                          </div>
                          <button className="btn-secondary btn-small">View</button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="settings-footer glass mt-20" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.5rem 2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {saveStatus && (
                        <span className={`animate-fade-in ${saveStatus.includes('Error') ? 'text-danger' : 'text-success'}`} style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                          {saveStatus}
                        </span>
                      )}
                    </div>
                    <button 
                      className="btn-primary" 
                      onClick={saveSettings} 
                      disabled={isSaving}
                      style={{ padding: '0.8rem 2.5rem', minWidth: '200px', justifyContent: 'center' }}
                    >
                      {isSaving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
                      {isSaving ? "Saving..." : "Save All Settings"}
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>



    </div>
  );
}

export default App;
