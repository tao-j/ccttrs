import { useCallback, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { load } from '@tauri-apps/plugin-store';
import { open } from '@tauri-apps/plugin-dialog';
import "./App.css";

interface SdCardProfile {
  id: string;
  profile_type: string;
  volume_name: string;
  staging_dir: string;
  last_file_path: string | null;
  last_file_timestamp: number | null;
  rename_nev_to_r3d?: boolean;
  skip_nikon_proxy_mp4?: boolean;
}

interface ProgressPayload {
  sd_path: string;
  files_copied: number;
  files_skipped: number;
  total_files: number;
  bytes_copied: number;
  total_bytes: number;
  true_bytes_copied: number;
  elapsed_secs: number;
  current_file: string;
}

interface DeviceInfo {
  name: string;
  mount_point: string;
  available_space: number;
  total_space: number;
  file_system: string;
  is_removable: boolean;
}

interface FileMeta {
  path: string;
  name: string;
  modified: number;
}

interface SpeedSample {
  elapsedSecs: number;
  bytesCopied: number;
}

interface TransferStats {
  rollingBytesPerSec: number | null;
  remainingSecs: number | null;
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '0 Bytes';
  if (bytes === 0) return '0 Bytes';
  if (bytes < 1) return `${bytes.toFixed(2)} Bytes`;

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDuration = (totalSeconds: number | null) => {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return "--";

  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
};

function CardTask({ 
  sdPath, 
  initialVolumeName, 
  store, 
  recentStagingDirs,
  onRemove,
  taskIsAuto,
  availableSpace,
  totalSpace,
  fileSystem,
  onProfileStatusChange,
  globalStagingDir,
  onEject,
  onCopyStatusChange
}: { 
  sdPath: string, 
  initialVolumeName: string, 
  store: any, 
  recentStagingDirs: string[],
  onRemove: () => void,
  taskIsAuto?: boolean,
  availableSpace?: number,
  totalSpace?: number,
  fileSystem?: string,
  onProfileStatusChange?: (sdPath: string, hasProfile: boolean) => void,
  globalStagingDir?: string,
  onEject?: () => void,
  onCopyStatusChange?: (sdPath: string, isCopying: boolean) => void
}) {
  const [stagingDir, setStagingDir] = useState("");
  const [profileType, setProfileType] = useState("Sony"); 
  const [volumeName, setVolumeName] = useState(initialVolumeName);
  const [renameNevToR3d, setRenameNevToR3d] = useState(true);
  const [skipNikonProxyMp4, setSkipNikonProxyMp4] = useState(true);

  const [profile, setProfile] = useState<SdCardProfile | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [isCopying, setIsCopying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [transferStats, setTransferStats] = useState<TransferStats>({
    rollingBytesPerSec: null,
    remainingSecs: null,
  });
  const speedSamplesRef = useRef<SpeedSample[]>([]);
  const [availableFiles, setAvailableFiles] = useState<FileMeta[]>([]);
  const [selectedStartFile, setSelectedStartFile] = useState<string>("");
  const [isFetchingFiles, setIsFetchingFiles] = useState(false);

  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenFinished: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;

    listen<ProgressPayload>("copy-progress", (event) => {
      if (event.payload.sd_path === sdPath) {
        setProgress(event.payload);
        updateTransferStats(event.payload);
        if (event.payload.files_copied + event.payload.files_skipped === event.payload.total_files && event.payload.total_files > 0) {
           setIsCopying(false);
           handleLoadProfile();
        }
      }
    }).then(u => unlistenProgress = u);
    
    listen<string>("copy-finished", (event) => {
       if (event.payload === sdPath) {
           setIsCopying(false);
           setProgress(null);
           resetTransferStats();
           handleLoadProfile();
       }
    }).then(u => unlistenFinished = u);

    listen<string>("copy-error", (event) => {
       // payload might be "sdPath|error_msg"
       const parts = event.payload.split('|');
       if (parts[0] === sdPath) {
           setIsCopying(false);
           setErrorMsg(parts[1] || "Copy failed");
           setProgress(null);
           resetTransferStats();
       }
    }).then(u => unlistenError = u);

    return () => { 
      if (unlistenProgress) unlistenProgress(); 
      if (unlistenFinished) unlistenFinished();
      if (unlistenError) unlistenError();
    };
  }, [sdPath]);

  useEffect(() => {
    handleLoadProfile();
  }, []);

  useEffect(() => {
    if (globalStagingDir && !isCopying) {
      setStagingDir(globalStagingDir);
    }
  }, [globalStagingDir]);

  useEffect(() => {
    onCopyStatusChange?.(sdPath, isCopying);

    return () => {
      if (isCopying) {
        onCopyStatusChange?.(sdPath, false);
      }
    };
  }, [isCopying, onCopyStatusChange, sdPath]);

  function resetTransferStats() {
    speedSamplesRef.current = [];
    setTransferStats({
      rollingBytesPerSec: null,
      remainingSecs: null,
    });
  }

  function updateTransferStats(nextProgress: ProgressPayload) {
    const currentSample = {
      elapsedSecs: nextProgress.elapsed_secs,
      bytesCopied: nextProgress.true_bytes_copied,
    };
    const rollingWindowStart = currentSample.elapsedSecs - 5;
    const samples = [...speedSamplesRef.current, currentSample].filter(
      sample => sample.elapsedSecs >= rollingWindowStart
    );
    const oldestSample = samples[0];
    const elapsedDelta = oldestSample
      ? currentSample.elapsedSecs - oldestSample.elapsedSecs
      : 0;
    const bytesDelta = oldestSample
      ? currentSample.bytesCopied - oldestSample.bytesCopied
      : 0;
    let rollingBytesPerSec: number | null = null;

    if (elapsedDelta >= 0.5 && bytesDelta >= 0) {
      rollingBytesPerSec = bytesDelta / elapsedDelta;
    } else if (currentSample.elapsedSecs > 0.05 && currentSample.bytesCopied > 0) {
      rollingBytesPerSec = currentSample.bytesCopied / currentSample.elapsedSecs;
    }

    const remainingBytes = Math.max(0, nextProgress.total_bytes - nextProgress.bytes_copied);
    const remainingSecs =
      rollingBytesPerSec && rollingBytesPerSec > 0
        ? remainingBytes / rollingBytesPerSec
        : null;

    speedSamplesRef.current = samples;
    setTransferStats({ rollingBytesPerSec, remainingSecs });
  }

  async function handleLoadProfile() {
    setErrorMsg("");
    setIsEditing(false);
    try {
      const p = await invoke<SdCardProfile>("load_profile", { sdPath });
      setProfile(p);
      if (!globalStagingDir) {
        setStagingDir(p.staging_dir);
      }
      setProfileType(p.profile_type);
      setVolumeName(p.volume_name);
      setRenameNevToR3d(p.rename_nev_to_r3d ?? true);
      setSkipNikonProxyMp4(p.skip_nikon_proxy_mp4 ?? true);
      if (onProfileStatusChange) onProfileStatusChange(sdPath, true);
    } catch (e: any) {
      setProfile(null);
      if (onProfileStatusChange) onProfileStatusChange(sdPath, false);
      const msg = typeof e === "string" ? e : "Unknown error";
      setErrorMsg(msg);
      if (msg === "Profile not found on SD card" || msg.includes("No such file")) {
        fetchMediaFiles(profileType, skipNikonProxyMp4);
      }
    }
  }

  async function fetchMediaFiles(type: string, skipProxyMp4 = skipNikonProxyMp4) {
    setIsFetchingFiles(true);
    try {
      const files = await invoke<FileMeta[]>("list_media_files", {
        sdPath,
        profileType: type,
        skipNikonProxyMp4: skipProxyMp4,
      });
      setAvailableFiles(files);
      if (files.length > 0) {
         setSelectedStartFile(""); 
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsFetchingFiles(false);
    }
  }

  useEffect(() => {
     if (sdPath && ((!profile && errorMsg) || isEditing)) {
         fetchMediaFiles(profileType, skipNikonProxyMp4);
     }
  }, [profileType, skipNikonProxyMp4]);

  async function handleInitProfile() {
    setErrorMsg("");
    if (!profileType || !volumeName) {
      setErrorMsg("Missing Setup Data. Please ensure card is valid.");
      return;
    }

    try {
      let last_file_path: string | null = null;
      let last_file_timestamp: number | null = null;

      if (selectedStartFile !== "") {
         const file = availableFiles.find(f => f.name === selectedStartFile);
         if (file) {
           last_file_path = file.name;
           last_file_timestamp = file.modified;
         } else {
           last_file_path = selectedStartFile;
         }
      }

      const p = await invoke<SdCardProfile>("init_profile", {
        sdPath,
        profileType,
        volumeName,
        stagingDir,
        lastFilePath: last_file_path,
        lastFileTimestamp: last_file_timestamp,
        renameNevToR3d,
        skipNikonProxyMp4,
      });

      setProfile(p);
      setIsEditing(false);
      
      if (onProfileStatusChange) onProfileStatusChange(sdPath, true);

      if (store && stagingDir) {
        let newDirs = [stagingDir, ...recentStagingDirs.filter(d => d !== stagingDir)].slice(0, 5);
        await store.set('recentStagingDirs', { dirs: newDirs });
        await store.save();
      }

    } catch (e: any) {
      setErrorMsg(typeof e === "string" ? e : "Unknown error");
    }
  }

  async function handleStartCopy() {
    setErrorMsg("");
    setIsCopying(true);
    setProgress(null);
    resetTransferStats();
    try {
      await invoke("start_copy", { sdPath, stagingDir });
      // We no longer `setIsCopying(false)` here because Rust returns immediately.
      // The progress listener will turn it off when 100% or error is reached.
    } catch (e: any) {
      setIsCopying(false);
      setErrorMsg(typeof e === "string" ? e : "Copy failed");
    }
  }

  async function handleCancelCopy() {
    try {
       await invoke("cancel_copy", { sdPath });
    } catch (e) {
       console.error("Cancel failed", e);
    }
  }

  async function handleSelectDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      
      if (selected && typeof selected === 'string') {
        setStagingDir(selected);
      }
    } catch (err) {
      console.error("Failed to open dialog", err);
    }
  }

  return (
    <div className="glass-card" style={{ marginTop: '1rem', position: 'relative' }}>
      {!taskIsAuto && (
        <button 
          onClick={onRemove} 
          disabled={isCopying}
          style={{
            position: 'absolute', top: '10px', right: '10px', background: 'transparent',
            color: '#ef4444', border: 'none', fontSize: '1.2rem', cursor: 'pointer', padding: '0 5px'
          }}
        >
          ✕
        </button>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', width: '100%' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.1rem', color: '#38bdf8' }}>{volumeName}</h2>
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{sdPath}</span>
          {(totalSpace !== undefined && availableSpace !== undefined) && (
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '4px' }}>
               {fileSystem && <span style={{ marginRight: '8px', padding: '2px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>{fileSystem}</span>}
               <span>{formatBytes(availableSpace)} free of {formatBytes(totalSpace)}</span>
            </div>
          )}
        </div>
        
        {profile && !isEditing && (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {isCopying ? (
                 <button
                    className="btn"
                    title="Cancel Copy"
                    style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)', color: '#fca5a5', padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={handleCancelCopy}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>
                  </button>
              ) : (
                  <button
                    className="btn"
                    title="Start Copy"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem' }}
                    onClick={handleStartCopy}
                    disabled={isCopying}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                  </button>
              )}
              
              <button
                className="btn"
                title="Edit Settings"
                style={{ background: 'rgba(255,255,255,0.1)', padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => {
                  fetchMediaFiles(profileType, skipNikonProxyMp4);
                  setIsEditing(true);
                  setErrorMsg("");
                }}
                disabled={isCopying}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </button>

              {/* Eject Button */}
              {onEject && (
                <button
                  className="btn"
                  title="Eject Drive"
                  style={{ background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.4)', color: '#fbbf24', padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={onEject}
                  disabled={isCopying}
                >
                  {/* Eject icon */}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 14 22 14"></polygon><line x1="2" y1="20" x2="22" y2="20"></line></svg>
                </button>
              )}
            </div>
        )}
      </div>

      {errorMsg && <div className="error-msg">{errorMsg}</div>}

      {/* Eject button when no profile initialized yet */}
      {!profile && !isEditing && onEject && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button
            className="btn"
            title="Eject Drive"
            style={{ background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.4)', color: '#fbbf24', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem' }}
            onClick={onEject}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 14 22 14"></polygon><line x1="2" y1="20" x2="22" y2="20"></line></svg>
            Eject
          </button>
        </div>
      )}

      {(!profile || isEditing) && (
        <div style={{ marginTop: "1rem", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "1rem" }}>
          <h3 style={{marginTop: 0, marginBottom: '1rem', fontSize: '1rem', color: '#f8fafc'}}>
             {isEditing ? "Edit Card Profile" : "Initialize New Card"}
          </h3>
          <div className="form-group">
            <label>Camera Brand / Hierarchy Type</label>
            <select 
              value={profileType}
              onChange={(e) => setProfileType(e.target.value)}
              disabled={isCopying}
            >
                <option value="Sony">Sony (DCIM/ & PRIVATE/M4ROOT/CLIP/)</option>
                <option value="Nikon">Nikon / Canon / Generic (DCIM/ only)</option>
            </select>
          </div>

          {profileType === "Nikon" && (
            <>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: isCopying ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={renameNevToR3d}
                    onChange={(e) => setRenameNevToR3d(e.target.checked)}
                    disabled={isCopying}
                    style={{ width: 'auto', margin: 0 }}
                  />
                  Rename Nikon .NEV files to .R3D during copy
                </label>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: isCopying ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={skipNikonProxyMp4}
                    onChange={(e) => setSkipNikonProxyMp4(e.target.checked)}
                    disabled={isCopying}
                    style={{ width: 'auto', margin: 0 }}
                  />
                  Skip Nikon same-name .MP4 proxy files when .NEV/.R3D exists
                </label>
              </div>
            </>
          )}

          <div className="form-group">
            <label>Staging Directory</label>
            {globalStagingDir ? (
              <div style={{ padding: '0.75rem 1rem', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '8px', border: '1px solid rgba(56, 189, 248, 0.2)', color: '#94a3b8', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#38bdf8', fontWeight: 600 }}>Using Global:</span>
                <span style={{ fontFamily: 'monospace', color: '#f8fafc', wordBreak: 'break-all' }}>{globalStagingDir}</span>
              </div>
            ) : (
              <>
                {recentStagingDirs.length > 0 && (
                  <select 
                    value={stagingDir} 
                    onChange={(e) => setStagingDir(e.target.value)}
                    disabled={isCopying}
                    style={{ marginBottom: '8px' }}
                  >
                     {recentStagingDirs.map((d, i) => (
                        <option key={i} value={d}>{d}</option>
                     ))}
                  </select>
                )}
                
                <div style={{display: 'flex', gap: '8px', marginTop: '4px'}}>
                    <input
                      style={{ flex: 1, margin: 0 }}
                      value={stagingDir}
                      onChange={(e) => setStagingDir(e.target.value)}
                      placeholder="e.g. /Users/name/Pictures/Staging"
                      disabled={isCopying}
                    />
                    <button 
                      onClick={handleSelectDirectory}
                      disabled={isCopying}
                      style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: '8px', padding: '0 1rem', cursor: 'pointer' }}
                    >
                      Browse...
                    </button>
                </div>
              </>
            )}
          </div>

          <div className="form-group">
            <label>Skip files older than... (Optional Initial Pointer)</label>
            <div style={{display: 'flex', gap: '8px'}}>
              <select 
                style={{ flex: 1 }}
                value={selectedStartFile} 
                onChange={(e) => setSelectedStartFile(e.target.value)}
                disabled={isFetchingFiles || isCopying}
              >
                 <option value="">(Copy Everything) Do not skip files</option>
                 {availableFiles.map((f, i) => (
                    <option key={i} value={f.name}>
                      {f.name} - {new Date(f.modified * 1000).toLocaleString()}
                    </option>
                 ))}
              </select>
              <button 
                onClick={async () => {
                  try {
                     const selected = await open({
                       multiple: false,
                       directory: false,
                       defaultPath: sdPath
                     });
                     if (selected && typeof selected === 'string') {
                       const filename = selected.split(/[/\\]/).pop();
                       if (filename) {
                         const found = availableFiles.find(f => f.name === filename);
                         if (found) {
                           setSelectedStartFile(found.name);
                         } else {
                           setSelectedStartFile(filename);
                         }
                       }
                     }
                  } catch (e) { console.error(e); }
                }}
                disabled={isFetchingFiles || isCopying}
                style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: '8px', padding: '0 1rem', cursor: 'pointer' }}
              >
                Browse...
              </button>
            </div>
            {isFetchingFiles && <span style={{fontSize: '0.8rem', color: '#94a3b8', marginTop: '4px'}}>Scanning card for images...</span>}
          </div>

          <div style={{ display: 'flex', gap: '1rem', marginTop: "1rem" }}>
            <button
              className="btn"
              style={{ flex: 1 }}
              onClick={handleInitProfile}
              disabled={!stagingDir || !profileType || isCopying}
            >
              {isEditing ? "Save Profile" : "Initialize Card"}
            </button>
            
            {isEditing && (
              <button
                className="btn"
                style={{ background: 'rgba(255,255,255,0.1)', flex: 0 }}
                onClick={() => {
                   setIsEditing(false);
                   setErrorMsg("");
                   handleLoadProfile();
                }}
                disabled={isCopying}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {profile && !isEditing && (
        <div className="profile-info" style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', fontSize: '0.875rem' }}>
              <div>
                <span style={{color: '#94a3b8', marginRight: '6px'}}>Type:</span>
                <span style={{color: '#38bdf8'}}>{profile.profile_type}</span>
              </div>
              {profile.profile_type === "Nikon" && (
                <>
                  <div>
                    <span style={{color: '#94a3b8', marginRight: '6px'}}>NEV Rename:</span>
                    <span style={{color: '#38bdf8'}}>
                      {(profile.rename_nev_to_r3d ?? true) ? "On" : "Off"}
                    </span>
                  </div>
                  <div>
                    <span style={{color: '#94a3b8', marginRight: '6px'}}>Proxy MP4 Skip:</span>
                    <span style={{color: '#38bdf8'}}>
                      {(profile.skip_nikon_proxy_mp4 ?? true) ? "On" : "Off"}
                    </span>
                  </div>
                </>
              )}
              <div style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{color: '#94a3b8', marginRight: '6px'}}>Staging:</span>
                <span style={{color: stagingDir === profile.staging_dir ? '#38bdf8' : '#fbbf24'}}>
                  {stagingDir}
                </span>
              </div>
              <div>
                <span style={{color: '#94a3b8', marginRight: '6px'}}>Last Sync:</span>
                <span style={{color: '#38bdf8'}}>
                   {profile.last_file_path || "None"}
                </span>
              </div>
          </div>

          {isCopying && progress && (
            <div className="progress-container">
              <div className="progress-stats">
                <span className="progress-stat">
                  <span className="progress-stat-value progress-stat-value-files">
                    {progress.files_copied} / {progress.total_files}
                  </span>
                  <span className="progress-stat-label">Files</span>
                  {progress.files_skipped > 0 && (
                    <span className="progress-stat-note">
                      ({progress.files_skipped} Skipped)
                    </span>
                  )}
                </span>
                <span className="progress-stat">
                  <span className="progress-stat-value progress-stat-value-bytes">
                    {formatBytes(progress.bytes_copied)} / {formatBytes(progress.total_bytes)}
                  </span>
                </span>
                <span className="progress-stat">
                  <span className="progress-stat-label">Speed:</span>
                  <span className="progress-stat-value progress-stat-value-speed">
                    {transferStats.rollingBytesPerSec !== null
                      ? `${formatBytes(transferStats.rollingBytesPerSec)}/s`
                      : 'Calculating...'}
                  </span>
                </span>
                <span className="progress-stat">
                  <span className="progress-stat-label">Elapsed:</span>
                  <span className="progress-stat-value progress-stat-value-duration">
                    {formatDuration(progress.elapsed_secs)}
                  </span>
                </span>
                <span className="progress-stat">
                  <span className="progress-stat-label">Remaining:</span>
                  <span className="progress-stat-value progress-stat-value-duration">
                    {formatDuration(transferStats.remainingSecs)}
                  </span>
                </span>
                <span className="progress-stat progress-stat-percent">
                  <span className="progress-stat-value progress-stat-value-percent">
                    {progress.total_bytes > 0
                      ? `${Math.round((progress.bytes_copied / progress.total_bytes) * 100)}%`
                      : '0%'}
                  </span>
                </span>
              </div>
              <div className="progress-bar-bg">
                <div
                  className="progress-bar-fill"
                  style={{
                    width: progress.total_bytes > 0 
                      ? `${(progress.bytes_copied / progress.total_bytes) * 100}%` 
                      : '0%',
                  }}
                />
              </div>
              <div className="current-file">{progress.current_file}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [recentStagingDirs, setRecentStagingDirs] = useState<string[]>([]);
  const [store, setStore] = useState<any>(null);
  const [profileStatuses, setProfileStatuses] = useState<Record<string, boolean>>({});
  const [globalStagingDir, setGlobalStagingDir] = useState("");
  const activeCopyPathsRef = useRef<string[]>([]);
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);

  const handleCopyStatusChange = useCallback((path: string, copying: boolean) => {
    const activeCopyPaths = activeCopyPathsRef.current;

    activeCopyPathsRef.current = copying
      ? (activeCopyPaths.includes(path) ? activeCopyPaths : [...activeCopyPaths, path])
      : activeCopyPaths.filter(activePath => activePath !== path);
  }, []);

  const setRefreshedDevices = useCallback((found: DeviceInfo[]) => {
    setDevices(prev => {
      const refreshedPaths = new Set(found.map(device => device.mount_point));
      const activeDevicesMissingFromRefresh = activeCopyPathsRef.current
        .filter(path => !refreshedPaths.has(path))
        .map(path => prev.find(device => device.mount_point === path))
        .filter((device): device is DeviceInfo => Boolean(device));

      return [...found, ...activeDevicesMissingFromRefresh];
    });
  }, []);

  useEffect(() => {
    async function init() {
      try {
        const found = await invoke<DeviceInfo[]>("list_devices");
        setRefreshedDevices(found);
      } catch (err) { console.error("Failed to list devices", err); }

      try {
        const s = await load('settings.json');
        setStore(s);
        const dirs = await s.get<{ dirs: string[] }>('recentStagingDirs');
        if (dirs && dirs.dirs) {
          setRecentStagingDirs(dirs.dirs);
        }
        const gDir = await s.get<string>('globalStagingDir');
        if (gDir) {
          setGlobalStagingDir(gDir);
        }
      } catch (err) { console.error("Failed to load store", err); }
    }
    init();
  }, [setRefreshedDevices]);

  // Update recent dirs globally when any task saves it
  useEffect(() => {
    const pollStore = setInterval(async () => {
      if (store) {
        const dirs = await store.get('recentStagingDirs');
        if (dirs && (dirs as any).dirs) {
          setRecentStagingDirs((dirs as any).dirs);
        }
        const gDir = await store.get('globalStagingDir');
        if (gDir && typeof gDir === 'string' && gDir !== globalStagingDir) {
          setGlobalStagingDir(gDir);
        }
      }
    }, 2000);
    return () => clearInterval(pollStore);
  }, [store, globalStagingDir]);

  async function handleSelectGlobalDir() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === 'string') {
        setGlobalStagingDir(selected);
        if (store) {
          await store.set('globalStagingDir', selected);
          await store.save();
        }
      }
    } catch (err) { console.error("Failed to open dialog", err); }
  }

  const handleProfileStatusChange = (path: string, hasProfile: boolean) => {
    setProfileStatuses(prev => ({...prev, [path]: hasProfile}));
  };

  async function handleRefresh() {
    setIsRefreshingDevices(true);
    try {
      const found = await invoke<DeviceInfo[]>("list_devices");
      setRefreshedDevices(found);
    } catch (err) { console.error("Failed to refresh devices", err); }
    finally { setIsRefreshingDevices(false); }
  }

  async function handleEject(mountPoint: string) {
    try {
      await invoke("eject_device", { mountPoint });
      // Remove the device from the list immediately
      setDevices(prev => prev.filter(d => d.mount_point !== mountPoint));
    } catch (err: any) {
      console.error("Eject failed", err);
    }
  }

  let allTasks = devices.map(d => ({ 
     path: d.mount_point, 
     name: d.name || d.mount_point, 
     availableSpace: d.available_space,
     totalSpace: d.total_space,
     fileSystem: d.file_system
  }));

  // Sort tasks: Autodetected profiles first, Autodetected without profiles second
  allTasks.sort((a, b) => {
      const aHasProfile = profileStatuses[a.path] || false;
      const bHasProfile = profileStatuses[b.path] || false;
      
      if (aHasProfile && !bHasProfile) return -1;
      if (!aHasProfile && bHasProfile) return 1;
      
      return 0;
  });

  return (
    <main className="container">
      <div className="glass-card" style={{ marginBottom: '1rem' }}>
        <h2 style={{marginTop: 0, fontSize: '1.2rem', color: '#f8fafc'}}>Session Settings</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.75rem' }}>
          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshingDevices}
            title={isRefreshingDevices ? "Refreshing drives" : "Rescan for new drives"}
            style={{ background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.4)', color: '#38bdf8', borderRadius: '8px', padding: '0.4rem 0.75rem', cursor: isRefreshingDevices ? 'wait' : 'pointer', opacity: isRefreshingDevices ? 0.65 : 1, display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            {isRefreshingDevices ? "Refreshing..." : "Refresh Drives"}
          </button>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Global Staging Directory (New Shot Destination)</label>
          <div style={{display: 'flex', gap: '8px'}}>
              <input
                style={{ flex: 1, margin: 0 }}
                value={globalStagingDir}
                onChange={async (e) => {
                  const val = e.target.value;
                  setGlobalStagingDir(val);
                  if (store) {
                    await store.set('globalStagingDir', val);
                    await store.save();
                  }
                }}
                placeholder="e.g. /Users/name/Pictures/CurrentSession"
              />
              <button 
                onClick={handleSelectGlobalDir}
                style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: '8px', padding: '0 1rem', cursor: 'pointer' }}
              >
                Browse...
              </button>
          </div>
          <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '8px', marginBottom: 0 }}>
            Updates all cards automatically to this path.
          </p>
        </div>
      </div>

      {devices.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <h2 style={{marginTop: 0, fontSize: '1.2rem', color: '#f8fafc'}}>Checking for SD Cards...</h2>
          <p style={{color: '#94a3b8', fontSize: '0.9rem', marginBottom: 0}}>Please insert a removable drive.</p>
        </div>
      ) : null}

      <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '1rem',
          alignItems: 'stretch',
          width: '100%'
      }}>
        {allTasks.map(task => (
           <CardTask 
             key={task.path} 
             sdPath={task.path} 
             initialVolumeName={task.name} 
             store={store}
             recentStagingDirs={recentStagingDirs}
             onRemove={() => {}}
             taskIsAuto={true}
             availableSpace={task.availableSpace}
             totalSpace={task.totalSpace}
             fileSystem={task.fileSystem}
             onProfileStatusChange={handleProfileStatusChange}
             globalStagingDir={globalStagingDir}
             onEject={() => handleEject(task.path)}
             onCopyStatusChange={handleCopyStatusChange}
           />
        ))}
      </div>
    </main>
  );
}

export default App;
